"""In-memory Solana chain for regression tests.

Builds RPC-shaped payloads containing genuine Anchor event encodings, and
serves them through :class:`FakeRpc`, which implements the same surface the
engine uses on :class:`app.providers.rpc.SolanaRpcClient`.

This is fixture data, not mock *results*: the engine still decodes real Borsh,
derives the real bonding-curve PDA, reads real balance deltas and computes
every score itself.  Nothing in the scoring path is stubbed.
"""

from __future__ import annotations

import base64
import hashlib
import itertools
from dataclasses import dataclass, field
from typing import Any

from app.pumpfun.constants import (
    ACCOUNT_DISCRIMINATORS,
    ANCHOR_CPI_EVENT_PREFIX,
    BONDING_CURVE_LAYOUT,
    COMPUTE_BUDGET_PROGRAM_ID,
    CREATE_EVENT_LAYOUT,
    LAMPORTS_PER_SOL,
    PUMP_EVENT_DISCRIMINATORS,
    PUMP_FUN_PROGRAM_ID,
    PUMP_INSTRUCTIONS,
    SYSTEM_PROGRAM_ID,
    TRADE_EVENT_LAYOUT,
)
from app.pumpfun.pda import bonding_curve_pda, global_pda, metadata_pda
from app.utils.addresses import b58encode
from tests.support.borsh_writer import BorshWriter, encode_struct

#: Matches the value Pump uses for a coin's initial real token reserves; only
#: the ratio matters for the tests that read graduation progress.
INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000
INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000
INITIAL_VIRTUAL_SOL_RESERVES = 30 * LAMPORTS_PER_SOL
TOKEN_TOTAL_SUPPLY = 1_000_000_000_000_000
DEFAULT_PUBKEY = SYSTEM_PROGRAM_ID


def address(seed: str) -> str:
    """Deterministic, valid 32-byte address derived from a label."""
    return b58encode(hashlib.sha256(seed.encode("utf-8")).digest())


def signature(seed: str) -> str:
    """Deterministic 64-byte signature string."""
    digest = hashlib.sha512(seed.encode("utf-8")).digest()
    return b58encode(digest)


def _event_payload(name: str, layout: list[tuple[str, str]], values: dict[str, Any]) -> bytes:
    return ANCHOR_CPI_EVENT_PREFIX + PUMP_EVENT_DISCRIMINATORS[name] + encode_struct(layout, values)


def _trade_event_payload(values: dict[str, Any], *, shareholders: int = 0, tail: dict | None = None) -> bytes:
    """TradeEvent, including the shareholders vec and the quote-mint tail."""
    body = encode_struct(TRADE_EVENT_LAYOUT, values)
    writer = BorshWriter().raw(body).u32(shareholders)
    for i in range(shareholders):
        writer.pubkey(address(f"shareholder-{i}")).u16(100)
    if tail:
        writer.pubkey(tail["quote_mint"]).u64(tail["quote_amount"]).u64(
            tail["virtual_quote_reserves"]
        ).u64(tail["real_quote_reserves"])
    return ANCHOR_CPI_EVENT_PREFIX + PUMP_EVENT_DISCRIMINATORS["TradeEvent"] + writer.build()


@dataclass
class _Tx:
    signature: str
    slot: int
    block_time: int
    accounts: list[str]
    pre: list[int]
    post: list[int]
    instruction_data: list[tuple[str, str]]  # (program_id, base58 data)
    inner: list[tuple[str, str]]
    logs: list[str] = field(default_factory=list)
    err: Any | None = None

    def to_json(self) -> dict[str, Any]:
        keys = list(self.accounts)
        index = {k: i for i, k in enumerate(keys)}
        return {
            "slot": self.slot,
            "blockTime": self.block_time,
            "transaction": {
                "signatures": [self.signature],
                "message": {
                    "accountKeys": keys,
                    "instructions": [
                        {"programIdIndex": index[program], "data": data, "accounts": []}
                        for program, data in self.instruction_data
                    ],
                },
            },
            "meta": {
                "err": self.err,
                "fee": 5000,
                "preBalances": self.pre,
                "postBalances": self.post,
                "preTokenBalances": [],
                "postTokenBalances": [],
                "innerInstructions": [
                    {
                        "index": 0,
                        "instructions": [
                            {"programIdIndex": index[program], "data": data, "accounts": []}
                            for program, data in self.inner
                        ],
                    }
                ]
                if self.inner
                else [],
                "logMessages": self.logs
                or [f"Program {PUMP_FUN_PROGRAM_ID} invoke [1]", f"Program {PUMP_FUN_PROGRAM_ID} success"],
            },
        }


class SyntheticChain:
    """Builds a coherent chain state: accounts, balances and transactions."""

    def __init__(self, *, start_slot: int = 300_000_000, start_time: int = 1_750_000_000) -> None:
        self.accounts: dict[str, dict[str, Any]] = {}
        self.balances: dict[str, int] = {}
        self.transactions: dict[str, dict[str, Any]] = {}
        self.signatures: dict[str, list[dict[str, Any]]] = {}
        self.holders: dict[str, list[dict[str, Any]]] = {}
        self.supply: dict[str, dict[str, Any]] = {}
        self._slot = itertools.count(start_slot)
        self.time = start_time
        self._install_global()

    # ------------------------------------------------------------------
    def _install_global(self) -> None:
        writer = (
            BorshWriter()
            .raw(ACCOUNT_DISCRIMINATORS["Global"])
            .bool(True)
            .pubkey(address("pump-authority"))
            .pubkey(address("pump-fee-recipient"))
            .u64(INITIAL_VIRTUAL_TOKEN_RESERVES)
            .u64(INITIAL_VIRTUAL_SOL_RESERVES)
            .u64(INITIAL_REAL_TOKEN_RESERVES)
        )
        self.accounts[global_pda()] = self._account(writer.build(), owner=PUMP_FUN_PROGRAM_ID)

    @staticmethod
    def _account(data: bytes, *, owner: str, lamports: int = 2_000_000) -> dict[str, Any]:
        return {
            "owner": owner,
            "lamports": lamports,
            "data": [base64.b64encode(data).decode("ascii"), "base64"],
            "executable": False,
            "rentEpoch": 0,
        }

    def next_slot(self) -> int:
        return next(self._slot)

    def set_balance(self, wallet: str, sol: float) -> None:
        self.balances[wallet] = int(sol * LAMPORTS_PER_SOL)

    # ------------------------------------------------------------------
    def _record(self, tx: _Tx) -> None:
        self.transactions[tx.signature] = tx.to_json()
        entry = {
            "signature": tx.signature,
            "slot": tx.slot,
            "blockTime": tx.block_time,
            "err": tx.err,
        }
        for account in tx.accounts:
            bucket = self.signatures.setdefault(account, [])
            bucket.append(entry)
            # RPC returns newest first.
            bucket.sort(key=lambda item: (item["blockTime"], item["slot"]), reverse=True)

    # ------------------------------------------------------------------
    def create_coin(
        self,
        *,
        mint: str,
        creator: str,
        symbol: str = "TEST",
        name: str = "Test Coin",
        block_time: int | None = None,
        mayhem: bool = False,
        quote_mint: str = DEFAULT_PUBKEY,
        complete: bool = False,
        real_token_reserves: int | None = None,
    ) -> str:
        """Emit a ``create`` transaction and install the bonding-curve account."""
        curve = bonding_curve_pda(mint)
        timestamp = block_time if block_time is not None else self.time
        slot = self.next_slot()
        sig = signature(f"create-{mint}")

        payload = _event_payload(
            "CreateEvent",
            CREATE_EVENT_LAYOUT,
            {
                "name": name,
                "symbol": symbol,
                "uri": f"https://example.invalid/{symbol}.json",
                "mint": mint,
                "bonding_curve": curve,
                "user": creator,
                "creator": creator,
                "timestamp": timestamp,
                "virtual_token_reserves": INITIAL_VIRTUAL_TOKEN_RESERVES,
                "virtual_sol_reserves": INITIAL_VIRTUAL_SOL_RESERVES,
                "real_token_reserves": INITIAL_REAL_TOKEN_RESERVES,
                "token_total_supply": TOKEN_TOTAL_SUPPLY,
                "token_program": address("token-program"),
                "is_mayhem_mode": mayhem,
                "is_cashback_enabled": False,
                "quote_mint": quote_mint,
                "virtual_quote_reserves": INITIAL_VIRTUAL_SOL_RESERVES,
            },
        )
        accounts = [creator, mint, curve, metadata_pda(mint), PUMP_FUN_PROGRAM_ID, SYSTEM_PROGRAM_ID]
        self._record(
            _Tx(
                signature=sig,
                slot=slot,
                block_time=timestamp,
                accounts=accounts,
                pre=[5 * LAMPORTS_PER_SOL, 0, 0, 0, 1, 1],
                post=[4 * LAMPORTS_PER_SOL, 0, 1_000_000, 1_000_000, 1, 1],
                instruction_data=[(PUMP_FUN_PROGRAM_ID, b58_data(PUMP_INSTRUCTIONS["create"]))],
                inner=[(PUMP_FUN_PROGRAM_ID, b58_data(payload))],
            )
        )

        self.set_curve(
            mint,
            complete=complete,
            creator=creator,
            mayhem=mayhem,
            quote_mint=quote_mint,
            real_token_reserves=real_token_reserves,
        )
        self.supply[mint] = {"amount": str(TOKEN_TOTAL_SUPPLY), "decimals": 6, "uiAmount": 1e9}
        return sig

    def set_curve(
        self,
        mint: str,
        *,
        complete: bool = False,
        creator: str,
        mayhem: bool = False,
        quote_mint: str = DEFAULT_PUBKEY,
        real_token_reserves: int | None = None,
    ) -> None:
        data = ACCOUNT_DISCRIMINATORS["BondingCurve"] + encode_struct(
            BONDING_CURVE_LAYOUT,
            {
                "virtual_token_reserves": INITIAL_VIRTUAL_TOKEN_RESERVES,
                "virtual_quote_reserves": INITIAL_VIRTUAL_SOL_RESERVES,
                "real_token_reserves": (
                    real_token_reserves
                    if real_token_reserves is not None
                    else (0 if complete else INITIAL_REAL_TOKEN_RESERVES)
                ),
                "real_quote_reserves": 3 * LAMPORTS_PER_SOL,
                "token_total_supply": TOKEN_TOTAL_SUPPLY,
                "complete": complete,
                "creator": creator,
                "is_mayhem_mode": mayhem,
                "is_cashback_coin": False,
                "quote_mint": quote_mint,
            },
        )
        self.accounts[bonding_curve_pda(mint)] = self._account(data, owner=PUMP_FUN_PROGRAM_ID)

    # ------------------------------------------------------------------
    def fund(
        self,
        *,
        source: str,
        recipient: str,
        sol: float,
        block_time: int,
        source_balance: float = 500.0,
    ) -> str:
        """A plain SOL transfer, expressed the way the chain expresses it: deltas."""
        lamports = int(sol * LAMPORTS_PER_SOL)
        sig = signature(f"fund-{source}-{recipient}-{block_time}")
        source_lamports = int(source_balance * LAMPORTS_PER_SOL)
        self._record(
            _Tx(
                signature=sig,
                slot=self.next_slot(),
                block_time=block_time,
                accounts=[source, recipient, SYSTEM_PROGRAM_ID],
                pre=[source_lamports, 0, 1],
                post=[source_lamports - lamports - 5000, lamports, 1],
                instruction_data=[(SYSTEM_PROGRAM_ID, b58_data(b"\x02\x00\x00\x00"))],
                inner=[],
                logs=[f"Program {SYSTEM_PROGRAM_ID} invoke [1]"],
            )
        )
        self.balances[recipient] = self.balances.get(recipient, 0) + lamports
        return sig

    def unrelated_activity(self, *, wallet: str, block_time: int, count: int = 1) -> None:
        """Transactions that move no value into the wallet — history without funding."""
        for i in range(count):
            sig = signature(f"noise-{wallet}-{block_time}-{i}")
            self._record(
                _Tx(
                    signature=sig,
                    slot=self.next_slot(),
                    block_time=block_time - i * 60,
                    accounts=[wallet, COMPUTE_BUDGET_PROGRAM_ID],
                    pre=[LAMPORTS_PER_SOL, 1],
                    post=[LAMPORTS_PER_SOL - 5000, 1],
                    instruction_data=[(COMPUTE_BUDGET_PROGRAM_ID, b58_data(b"\x03"))],
                    inner=[],
                    logs=[f"Program {COMPUTE_BUDGET_PROGRAM_ID} invoke [1]"],
                )
            )

    def buy(
        self,
        *,
        mint: str,
        wallet: str,
        sol: float,
        block_time: int,
        creator: str,
        slot: int | None = None,
        tokens: float | None = None,
        mayhem: bool = False,
        quote_mint: str = DEFAULT_PUBKEY,
        real_token_reserves: int | None = None,
        wallet_balance: float = 5.0,
        fee_payer: str | None = None,
    ) -> str:
        return self._trade(
            mint=mint,
            wallet=wallet,
            sol=sol,
            block_time=block_time,
            creator=creator,
            slot=slot,
            tokens=tokens,
            is_buy=True,
            mayhem=mayhem,
            quote_mint=quote_mint,
            real_token_reserves=real_token_reserves,
            wallet_balance=wallet_balance,
            fee_payer=fee_payer,
        )

    def sell(
        self,
        *,
        mint: str,
        wallet: str,
        sol: float,
        block_time: int,
        creator: str,
        tokens: float | None = None,
        slot: int | None = None,
    ) -> str:
        return self._trade(
            mint=mint,
            wallet=wallet,
            sol=sol,
            block_time=block_time,
            creator=creator,
            slot=slot,
            tokens=tokens,
            is_buy=False,
        )

    def _trade(
        self,
        *,
        mint: str,
        wallet: str,
        sol: float,
        block_time: int,
        creator: str,
        is_buy: bool,
        slot: int | None = None,
        tokens: float | None = None,
        mayhem: bool = False,
        quote_mint: str = DEFAULT_PUBKEY,
        real_token_reserves: int | None = None,
        wallet_balance: float = 5.0,
        fee_payer: str | None = None,
    ) -> str:
        lamports = int(sol * LAMPORTS_PER_SOL)
        token_amount = int((tokens if tokens is not None else sol * 1_000_000) * 1_000_000)
        curve = bonding_curve_pda(mint)
        sig = signature(f"{'buy' if is_buy else 'sell'}-{mint}-{wallet}-{block_time}")
        used_slot = slot if slot is not None else self.next_slot()
        remaining = (
            real_token_reserves if real_token_reserves is not None else INITIAL_REAL_TOKEN_RESERVES - token_amount
        )

        payload = _trade_event_payload(
            {
                "mint": mint,
                "sol_amount": lamports,
                "token_amount": token_amount,
                "is_buy": is_buy,
                "user": wallet,
                "timestamp": block_time,
                "virtual_sol_reserves": INITIAL_VIRTUAL_SOL_RESERVES + lamports,
                "virtual_token_reserves": INITIAL_VIRTUAL_TOKEN_RESERVES - token_amount,
                "real_sol_reserves": lamports,
                "real_token_reserves": remaining,
                "fee_recipient": address("pump-fee-recipient"),
                "fee_basis_points": 100,
                "fee": lamports // 100,
                "creator": creator,
                "creator_fee_basis_points": 5,
                "creator_fee": lamports // 2000,
                "track_volume": True,
                "total_unclaimed_tokens": 0,
                "total_claimed_tokens": 0,
                "current_sol_volume": lamports,
                "last_update_timestamp": block_time,
                "ix_name": "buy" if is_buy else "sell",
                "mayhem_mode": mayhem,
                "cashback_fee_basis_points": 0,
                "cashback": 0,
                "buyback_fee_basis_points": 0,
                "buyback_fee": 0,
            },
            tail={
                "quote_mint": quote_mint,
                "quote_amount": lamports,
                "virtual_quote_reserves": INITIAL_VIRTUAL_SOL_RESERVES + lamports,
                "real_quote_reserves": lamports,
            },
        )

        wallet_lamports = int(wallet_balance * LAMPORTS_PER_SOL)
        delta = -lamports if is_buy else lamports
        # Le payeur de frais est, par construction Solana, le premier compte.
        if fee_payer and fee_payer != wallet:
            accounts = [fee_payer, wallet, mint, curve, PUMP_FUN_PROGRAM_ID, SYSTEM_PROGRAM_ID]
            pre = [5 * LAMPORTS_PER_SOL, wallet_lamports, 0, 1_000_000, 1, 1]
            post = [5 * LAMPORTS_PER_SOL - 5000, wallet_lamports + delta, 0, 1_000_000 - delta, 1, 1]
        else:
            accounts = [wallet, mint, curve, PUMP_FUN_PROGRAM_ID, SYSTEM_PROGRAM_ID]
            pre = [wallet_lamports, 0, 1_000_000, 1, 1]
            post = [wallet_lamports + delta - 5000, 0, 1_000_000 - delta, 1, 1]
        self._record(
            _Tx(
                signature=sig,
                slot=used_slot,
                block_time=block_time,
                accounts=accounts,
                pre=pre,
                post=post,
                instruction_data=[
                    (
                        PUMP_FUN_PROGRAM_ID,
                        b58_data(PUMP_INSTRUCTIONS["buy" if is_buy else "sell"]),
                    )
                ],
                inner=[(PUMP_FUN_PROGRAM_ID, b58_data(payload))],
            )
        )
        return sig

    def atomic_buy(
        self,
        *,
        mint: str,
        wallets: list[str],
        sol: float,
        block_time: int,
        creator: str,
        fee_payer: str,
        slot: int | None = None,
    ) -> str:
        """Une *seule* transaction faisant acheter plusieurs wallets.

        C'est la forme la plus dure à expliquer autrement que par un opérateur
        unique : l'atomicité impose que toutes les signatures soient réunies au
        moment de la construction de la transaction.
        """
        lamports = int(sol * LAMPORTS_PER_SOL)
        token_amount = int(sol * 1_000_000 * 1_000_000)
        curve = bonding_curve_pda(mint)
        sig = signature(f"atomic-{mint}-{block_time}-{len(wallets)}")
        used_slot = slot if slot is not None else self.next_slot()

        inner: list[tuple[str, str]] = []
        for index, wallet in enumerate(wallets):
            payload = _trade_event_payload(
                {
                    "mint": mint,
                    "sol_amount": lamports,
                    "token_amount": token_amount,
                    "is_buy": True,
                    "user": wallet,
                    "timestamp": block_time,
                    "virtual_sol_reserves": INITIAL_VIRTUAL_SOL_RESERVES + lamports * (index + 1),
                    "virtual_token_reserves": INITIAL_VIRTUAL_TOKEN_RESERVES - token_amount * (index + 1),
                    "real_sol_reserves": lamports * (index + 1),
                    "real_token_reserves": INITIAL_REAL_TOKEN_RESERVES - token_amount * (index + 1),
                    "fee_recipient": address("pump-fee-recipient"),
                    "fee_basis_points": 100,
                    "fee": lamports // 100,
                    "creator": creator,
                    "creator_fee_basis_points": 5,
                    "creator_fee": lamports // 2000,
                    "track_volume": True,
                    "total_unclaimed_tokens": 0,
                    "total_claimed_tokens": 0,
                    "current_sol_volume": lamports,
                    "last_update_timestamp": block_time,
                    "ix_name": "buy",
                    "mayhem_mode": False,
                    "cashback_fee_basis_points": 0,
                    "cashback": 0,
                    "buyback_fee_basis_points": 0,
                    "buyback_fee": 0,
                },
                tail={
                    "quote_mint": DEFAULT_PUBKEY,
                    "quote_amount": lamports,
                    "virtual_quote_reserves": INITIAL_VIRTUAL_SOL_RESERVES + lamports,
                    "real_quote_reserves": lamports,
                },
            )
            inner.append((PUMP_FUN_PROGRAM_ID, b58_data(payload)))

        accounts = [fee_payer, *wallets, mint, curve, PUMP_FUN_PROGRAM_ID, SYSTEM_PROGRAM_ID]
        balance = 20 * LAMPORTS_PER_SOL
        pre = [balance] + [3 * LAMPORTS_PER_SOL] * len(wallets) + [0, 1_000_000, 1, 1]
        post = (
            [balance - 5000]
            + [3 * LAMPORTS_PER_SOL - lamports] * len(wallets)
            + [0, 1_000_000 + lamports * len(wallets), 1, 1]
        )
        self._record(
            _Tx(
                signature=sig,
                slot=used_slot,
                block_time=block_time,
                accounts=accounts,
                pre=pre,
                post=post,
                instruction_data=[(PUMP_FUN_PROGRAM_ID, b58_data(PUMP_INSTRUCTIONS["buy"]))],
                inner=inner,
            )
        )
        return sig

    def set_holders(self, mint: str, holders: list[tuple[str, int]]) -> None:
        self.holders[mint] = [
            {
                "token_account": address(f"ata-{owner}-{mint}"),
                "owner": owner,
                "amount": amount,
                "decimals": 6,
                "ui_amount": amount / 1e6,
            }
            for owner, amount in holders
        ]


def b58_data(payload: bytes) -> str:
    return b58encode(payload)


class FakeRpc:
    """Serves a :class:`SyntheticChain` through the engine's RPC surface."""

    name = "fake-rpc"

    def __init__(self, chain: SyntheticChain, quality=None) -> None:
        self.chain = chain
        self.quality = quality
        self.calls: dict[str, int] = {}

    def _count(self, method: str) -> None:
        self.calls[method] = self.calls.get(method, 0) + 1

    async def aclose(self) -> None:
        return None

    async def get_account_info(self, address_: str) -> dict[str, Any] | None:
        self._count("getAccountInfo")
        return self.chain.accounts.get(address_)

    async def get_multiple_accounts(self, addresses: list[str]) -> list[dict[str, Any] | None]:
        self._count("getMultipleAccounts")
        return [self.chain.accounts.get(a) for a in addresses]

    async def get_balance(self, address_: str) -> int:
        self._count("getBalance")
        return self.chain.balances.get(address_, 0)

    async def get_balances(self, addresses: list[str]) -> dict[str, int]:
        self._count("getBalances")
        return {a: self.chain.balances.get(a, 0) for a in addresses}

    async def get_signatures(
        self, address_: str, *, limit: int = 1000, before: str | None = None, until: str | None = None
    ) -> list[dict[str, Any]]:
        self._count("getSignaturesForAddress")
        entries = list(self.chain.signatures.get(address_, []))
        if before:
            for index, entry in enumerate(entries):
                if entry["signature"] == before:
                    entries = entries[index + 1 :]
                    break
            else:
                entries = []
        return entries[:limit]

    async def prefetch_signatures(self, addresses: list[str], *, limit: int = 200) -> None:
        """Sans effet ici : la chaîne en mémoire répond déjà instantanément.

        Le vrai gain du préchargement se mesure au niveau HTTP, avec
        `tests.support.rpc_server`, qui fait tourner le client réel.
        """
        self._count("prefetchSignatures")

    async def get_signatures_paged(
        self,
        address_: str,
        *,
        max_signatures: int = 1000,
        until: str | None = None,
        stop_before_time: int | None = None,
    ) -> list[dict[str, Any]]:
        return await self.get_signatures(address_, limit=max_signatures)

    async def get_oldest_signature(self, address_: str, *, max_pages: int = 12) -> dict[str, Any] | None:
        entries = self.chain.signatures.get(address_, [])
        return entries[-1] if entries else None

    async def get_transaction(self, sig: str) -> dict[str, Any] | None:
        self._count("getTransaction")
        return self.chain.transactions.get(sig)

    async def get_transactions(self, signatures: list[str]) -> dict[str, dict[str, Any] | None]:
        self._count("getTransactions")
        if self.quality is not None:
            self.quality.transactions_analyzed += len(signatures)
        return {s: self.chain.transactions.get(s) for s in signatures}

    async def get_token_holders(self, mint: str, *, limit: int = 50) -> list[dict[str, Any]]:
        self._count("getTokenLargestAccounts")
        return self.chain.holders.get(mint, [])[:limit]

    async def get_token_supply(self, mint: str) -> dict[str, Any] | None:
        self._count("getTokenSupply")
        return self.chain.supply.get(mint)

    async def get_slot(self) -> int:
        return self.chain.next_slot()

    async def get_block_time(self, slot: int) -> int | None:
        return self.chain.time
