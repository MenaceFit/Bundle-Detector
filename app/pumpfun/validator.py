"""Pump.fun origin validation — the gate every scan must pass (§2, §7).

The scanner analyses Pump.fun launches and nothing else.  Proving origin is
therefore the first and most important step, and it has to be *cheap*: the
validator answers with a single account read in the common case.

How it works
------------
The bonding-curve address is a PDA of the Pump program derived from the mint
(``["bonding-curve", mint]``).  If that account exists, is owned by
``6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`` and decodes against the
``BondingCurve`` layout, the mint was created by Pump.fun.  No other program
can write to that address — a Raydium-native or SPL-only token cannot produce
one.  A graduated coin keeps its curve account (with ``complete = true``),
which is why graduated coins still validate and remain analysable on PumpSwap.

If the account read is inconclusive, the validator falls back to searching the
mint's own transaction history for Pump program activity before giving up.
"""

from __future__ import annotations

from app.models.token import ValidationResult
from app.providers.base import ProviderError
from app.providers.registry import ProviderHub
from app.pumpfun.constants import PUMP_FUN_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID
from app.pumpfun.events import decode_account_data, decode_bonding_curve, parse_transaction
from app.pumpfun.pda import bonding_curve_pda, metadata_pda
from app.utils.addresses import is_valid_pubkey
from app.utils.logging import get_logger

log = get_logger("SCAN")

NOT_PUMPFUN_MESSAGE = (
    "❌ NOT A PUMP.FUN TOKEN\n\nThis scanner only analyzes Pump.fun launches."
)


class ProviderUnavailableError(RuntimeError):
    """Le RPC n'a pas pu répondre : on ne sait pas, et on le dit.

    Volontairement distinct de « ce n'est pas un token Pump.fun ». Rendre un
    verdict quand aucune donnée n'a pu être lue serait la pire réponse
    possible pour un outil dont tout l'intérêt est la traçabilité.
    """


class PumpFunValidator:
    def __init__(self, hub: ProviderHub) -> None:
        self.hub = hub

    async def validate(self, mint: str) -> ValidationResult:
        result = ValidationResult(mint=mint)

        if not is_valid_pubkey(mint):
            result.reason = "Not a valid Solana address (must decode to 32 bytes of base58)."
            result.checks["valid_address"] = False
            return result
        result.checks["valid_address"] = True

        curve_address = bonding_curve_pda(mint)
        result.bonding_curve = curve_address

        # Distinguer « le compte n'existe pas » de « je n'ai pas pu regarder ».
        # Les confondre ferait dire au scanner « ce n'est pas un token Pump.fun »
        # alors que le RPC est simplement injoignable : une panne d'infra
        # déguisée en verdict, ce qui est pire que pas de réponse du tout.
        read_failed = False
        try:
            account = await self.hub.rpc.get_account_info(curve_address)
        except ProviderError as exc:
            log.warning("bonding curve read failed", mint=mint, error=str(exc))
            account = None
            read_failed = True

        curve_state = None
        if account:
            result.bonding_curve_exists = True
            owner_ok = account.get("owner") == PUMP_FUN_PROGRAM_ID
            result.checks["curve_owned_by_pump"] = owner_ok
            if owner_ok:
                curve_state = decode_bonding_curve(decode_account_data(account) or b"")
                result.checks["curve_decodes"] = curve_state is not None
        else:
            result.checks["curve_account_exists"] = False

        if curve_state is not None:
            result.is_pumpfun_token = True
            result.launch_source = "pump.fun bonding curve"
            result.pumpfun_program_activity = True
            result.creator = curve_state.get("creator")
            result.graduation_status = "GRADUATED" if curve_state.get("complete") else "BONDING_CURVE"
        else:
            # Fallback: look for Pump program activity in the mint's own history.
            touched, fallback_failed = await self._touches_pump_program(mint)
            result.checks["pump_program_activity"] = touched
            if touched:
                result.is_pumpfun_token = True
                result.launch_source = "pump.fun program activity"
                result.pumpfun_program_activity = True
            elif read_failed and fallback_failed:
                # Aucune des deux vérifications n'a pu aboutir : on ne sait pas,
                # et le dire est la seule réponse honnête.
                raise ProviderUnavailableError(
                    "Impossible de joindre le RPC Solana pour vérifier l'origine de ce token. "
                    "Ce n'est pas un verdict sur le token : réessayez, ou vérifiez votre "
                    "endpoint RPC (`/settings` affiche l'état des fournisseurs)."
                )
            else:
                result.reason = (
                    "No Pump.fun bonding curve exists for this mint and no Pump.fun program "
                    "activity was found in its history."
                )
                return result

        creation = await self._find_creation(mint, curve_address)
        if creation:
            result.creation_time = creation.get("block_time")
            result.creation_signature = creation.get("signature")
            result.creator = creation.get("creator") or result.creator
            result.launch_source = "pump.fun create instruction"

        return result

    async def _touches_pump_program(self, mint: str) -> tuple[bool, bool]:
        """Repli : l'historique du mint touche-t-il le programme Pump ?

        Renvoie ``(touché, la_lecture_a_échoué)``. Le second drapeau est ce qui
        permet de ne pas confondre « rien trouvé » et « rien pu regarder ».
        """
        try:
            signatures = await self.hub.rpc.get_signatures(mint, limit=25)
        except ProviderError:
            return False, True
        if not signatures:
            return False, False
        sigs = [s["signature"] for s in signatures[:10] if s.get("signature")]
        try:
            transactions = await self.hub.rpc.get_transactions(sigs)
        except ProviderError:
            return False, True
        if not any(raw for raw in transactions.values()):
            return False, True
        for sig, raw in transactions.items():
            parsed = parse_transaction(raw, sig)
            if parsed and (
                PUMP_FUN_PROGRAM_ID in parsed.programs or PUMP_SWAP_PROGRAM_ID in parsed.programs
            ):
                return True, False
        return False, False

    async def _find_creation(self, mint: str, curve_address: str) -> dict | None:
        """Locate the ``create`` transaction and read its ``CreateEvent``.

        The Metaplex metadata PDA is tried first: it is written at creation and
        rarely touched afterwards, so its oldest signature is the creation
        transaction and the lookup costs one page instead of walking a busy
        curve's entire history.  The bonding curve is the fallback.
        """
        for address in (metadata_pda(mint), curve_address):
            try:
                oldest = await self.hub.rpc.get_oldest_signature(address, max_pages=6)
            except ProviderError:
                continue
            if not oldest or not oldest.get("signature"):
                continue
            signature = oldest["signature"]
            raw = await self.hub.rpc.get_transaction(signature)
            parsed = parse_transaction(raw, signature)
            if not parsed:
                continue
            events = parsed.events_named("CreateEvent")
            if events:
                event = events[0]
                return {
                    "signature": signature,
                    "block_time": event.get("timestamp") or parsed.block_time,
                    "slot": parsed.slot,
                    "creator": event.get("creator") or event.get("user"),
                    "event": event,
                }
            # No CreateEvent decoded, but the transaction is still the earliest
            # one touching this account — use it for timing only.
            if PUMP_FUN_PROGRAM_ID in parsed.programs:
                return {
                    "signature": signature,
                    "block_time": parsed.block_time,
                    "slot": parsed.slot,
                    "creator": None,
                    "event": None,
                }
        return None
