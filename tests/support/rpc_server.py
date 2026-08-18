"""Serveur JSON-RPC simulé, au niveau HTTP.

Contrairement à ``FakeRpc`` — qui remplace tout le client — celui-ci ne
remplace que le transport. Le vrai :class:`SolanaRpcClient` tourne au-dessus :
son cache de signatures, son groupement de requêtes, sa déduplication, son seau
à jetons et ses disjoncteurs sont réellement exercés.

C'est la seule façon honnête de mesurer le coût d'un scan : compter les
requêtes HTTP effectivement émises, et non les appels de méthode Python.
"""

from __future__ import annotations

import json
from collections import Counter
from typing import Any

import httpx

from app.providers.rpc import SolanaRpcClient
from tests.support.chain import SyntheticChain


class RecordingRpcServer:
    """Répond aux méthodes JSON-RPC utilisées par le moteur, et compte."""

    def __init__(self, chain: SyntheticChain) -> None:
        self.chain = chain
        #: Requêtes HTTP réellement émises (ce qui détermine la durée réelle).
        self.http_requests = 0
        #: Appels JSON-RPC, groupés compris (ce que facture le fournisseur).
        self.rpc_calls: Counter[str] = Counter()
        self.batch_sizes: list[int] = []

    # ------------------------------------------------------------------
    def _dispatch(self, method: str, params: list[Any]) -> Any:
        self.rpc_calls[method] += 1
        chain = self.chain

        if method == "getAccountInfo":
            return {"value": chain.accounts.get(params[0])}
        if method == "getMultipleAccounts":
            return {"value": [chain.accounts.get(a) for a in params[0]]}
        if method == "getBalance":
            return {"value": chain.balances.get(params[0], 0)}
        if method == "getTokenSupply":
            return {"value": chain.supply.get(params[0])}
        if method == "getTokenLargestAccounts":
            holders = chain.holders.get(params[0], [])
            return {
                "value": [
                    {
                        "address": h["token_account"],
                        "amount": str(h["amount"]),
                        "decimals": h.get("decimals") or 6,
                        "uiAmount": h.get("ui_amount") or 0.0,
                    }
                    for h in holders
                ]
            }
        if method == "getSignaturesForAddress":
            address = params[0]
            options = params[1] if len(params) > 1 else {}
            entries = list(chain.signatures.get(address, []))
            before = options.get("before")
            if before:
                for index, entry in enumerate(entries):
                    if entry["signature"] == before:
                        entries = entries[index + 1 :]
                        break
                else:
                    entries = []
            return entries[: options.get("limit", 1000)]
        if method == "getTransaction":
            return chain.transactions.get(params[0])
        if method == "getSlot":
            return chain.next_slot()
        if method == "getBlockTime":
            return chain.time
        if method == "getHealth":
            return "ok"
        return None

    # ------------------------------------------------------------------
    def handler(self, request: httpx.Request) -> httpx.Response:
        self.http_requests += 1
        payload = json.loads(request.content)

        if isinstance(payload, list):
            self.batch_sizes.append(len(payload))
            body = [
                {"jsonrpc": "2.0", "id": item.get("id"), "result": self._dispatch(item["method"], item.get("params") or [])}
                for item in payload
            ]
        else:
            body = {
                "jsonrpc": "2.0",
                "id": payload.get("id"),
                "result": self._dispatch(payload["method"], payload.get("params") or []),
            }
        return httpx.Response(200, json=body)

    def summary(self) -> dict[str, Any]:
        return {
            "http_requests": self.http_requests,
            "rpc_calls": sum(self.rpc_calls.values()),
            "by_method": dict(self.rpc_calls.most_common()),
            "batches": len(self.batch_sizes),
            "avg_batch": (sum(self.batch_sizes) / len(self.batch_sizes)) if self.batch_sizes else 0,
        }


def build_client(chain: SyntheticChain, **kwargs: Any) -> tuple[SolanaRpcClient, RecordingRpcServer]:
    """Un vrai :class:`SolanaRpcClient` branché sur la chaîne synthétique."""
    server = RecordingRpcServer(chain)
    client = SolanaRpcClient(
        ["https://rpc.test.invalid"],
        requests_per_second=kwargs.pop("requests_per_second", 1000.0),
        max_concurrent=kwargs.pop("max_concurrent", 16),
        **kwargs,
    )
    # On ne remplace que la couche transport : tout le reste du client est réel.
    client._client = httpx.AsyncClient(
        transport=httpx.MockTransport(server.handler),
        headers={"content-type": "application/json"},
    )
    return client, server
