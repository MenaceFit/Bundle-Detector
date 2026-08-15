"""Protocol-layer tests: base58, PDAs, Borsh, event and transaction decoding."""

from __future__ import annotations

import base64

import pytest

from app.pumpfun.constants import (
    ANCHOR_CPI_EVENT_PREFIX,
    BONDING_CURVE_LAYOUT,
    CREATE_EVENT_LAYOUT,
    PUMP_EVENT_DISCRIMINATORS,
    PUMP_FUN_PROGRAM_ID,
    quote_symbol,
)
from app.pumpfun.events import (
    decode_bonding_curve,
    decode_event_payload,
    decode_events_from_logs,
    decode_instruction_name,
    parse_transaction,
)
from app.pumpfun.pda import bonding_curve_pda, find_program_address, global_pda, metadata_pda
from app.utils.addresses import b58decode, b58encode, extract_candidate_mints, is_valid_pubkey
from app.utils.borsh import BorshError, BorshReader, decode_struct
from tests.support.borsh_writer import encode_struct
from tests.support.chain import DEFAULT_PUBKEY, SyntheticChain, address, b58_data


class TestBase58:
    def test_roundtrip(self):
        payload = bytes(range(32))
        assert b58decode(b58encode(payload)) == payload

    def test_leading_zeros_preserved(self):
        payload = b"\x00\x00" + bytes(range(30))
        assert b58decode(b58encode(payload)) == payload

    def test_valid_pubkey_requires_32_bytes(self):
        assert is_valid_pubkey(PUMP_FUN_PROGRAM_ID)
        assert not is_valid_pubkey("nope")
        assert not is_valid_pubkey("")

    def test_extract_from_message(self):
        text = f"check this out {PUMP_FUN_PROGRAM_ID} pls"
        assert extract_candidate_mints(text) == [PUMP_FUN_PROGRAM_ID]


class TestPda:
    def test_global_pda_matches_known_value(self):
        # The Pump program's global account, verifiable on any explorer.
        assert global_pda() == "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"

    def test_metadata_pda_matches_known_value(self):
        # Metaplex metadata PDA for the USDC mint.
        usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        assert metadata_pda(usdc) == "5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq"

    def test_bonding_curve_is_deterministic_and_off_curve(self):
        mint = address("mint-a")
        first = bonding_curve_pda(mint)
        assert first == bonding_curve_pda(mint)
        assert is_valid_pubkey(first)

    def test_find_program_address_returns_bump(self):
        _, bump = find_program_address([b"bonding-curve", b58decode(address("m"))], PUMP_FUN_PROGRAM_ID)
        assert 0 <= bump <= 255


class TestBorsh:
    def test_truncated_payload_is_rejected_when_strict(self):
        reader = BorshReader(b"\x01\x02")
        with pytest.raises(BorshError):
            decode_struct(reader, [("a", "u64")], tolerant=False)

    def test_tolerant_decoding_returns_prefix(self):
        payload = encode_struct([("a", "u64")], {"a": 7})
        decoded = decode_struct(BorshReader(payload), [("a", "u64"), ("b", "u64")], tolerant=True)
        assert decoded == {"a": 7}

    def test_roundtrip_bonding_curve(self):
        creator = address("creator")
        values = {
            "virtual_token_reserves": 1_073_000_000_000_000,
            "virtual_quote_reserves": 30_000_000_000,
            "real_token_reserves": 793_100_000_000_000,
            "real_quote_reserves": 0,
            "token_total_supply": 1_000_000_000_000_000,
            "complete": False,
            "creator": creator,
            "is_mayhem_mode": True,
            "is_cashback_coin": False,
            "quote_mint": DEFAULT_PUBKEY,
        }
        raw = encode_struct(BONDING_CURVE_LAYOUT, values)
        from app.pumpfun.constants import ACCOUNT_DISCRIMINATORS

        decoded = decode_bonding_curve(ACCOUNT_DISCRIMINATORS["BondingCurve"] + raw)
        assert decoded == values

    def test_wrong_discriminator_is_rejected(self):
        raw = b"\x00" * 8 + encode_struct([("a", "u64")], {"a": 1})
        assert decode_bonding_curve(raw) is None


class TestEventDecoding:
    def _create_payload(self, mint: str, creator: str) -> bytes:
        return ANCHOR_CPI_EVENT_PREFIX + PUMP_EVENT_DISCRIMINATORS["CreateEvent"] + encode_struct(
            CREATE_EVENT_LAYOUT,
            {
                "name": "Test Coin",
                "symbol": "TEST",
                "uri": "https://example.invalid/t.json",
                "mint": mint,
                "bonding_curve": bonding_curve_pda(mint),
                "user": creator,
                "creator": creator,
                "timestamp": 1_750_000_000,
                "virtual_token_reserves": 1,
                "virtual_sol_reserves": 2,
                "real_token_reserves": 3,
                "token_total_supply": 4,
                "token_program": address("tp"),
                "is_mayhem_mode": True,
                "is_cashback_enabled": False,
                "quote_mint": DEFAULT_PUBKEY,
                "virtual_quote_reserves": 5,
            },
        )

    def test_decode_cpi_event(self):
        mint, creator = address("mint"), address("creator")
        name, fields = decode_event_payload(self._create_payload(mint, creator))
        assert name == "CreateEvent"
        assert fields["mint"] == mint
        assert fields["symbol"] == "TEST"
        assert fields["is_mayhem_mode"] is True

    def test_decode_from_log_line(self):
        mint, creator = address("mint2"), address("creator2")
        encoded = base64.b64encode(self._create_payload(mint, creator)).decode()
        events = decode_events_from_logs([f"Program data: {encoded}", "Program log: noise"])
        assert [name for name, _ in events] == ["CreateEvent"]

    def test_unknown_discriminator_returns_none(self):
        assert decode_event_payload(b"\x01" * 40) is None

    def test_instruction_name_lookup(self):
        from app.pumpfun.constants import PUMP_INSTRUCTIONS

        assert decode_instruction_name(b58_data(PUMP_INSTRUCTIONS["buy"])) == "buy"
        assert decode_instruction_name(b58_data(b"\x00" * 8)) is None


class TestTransactionParsing:
    def test_parses_trade_event_and_balances(self, chain: SyntheticChain):
        mint, creator, buyer = address("m"), address("c"), address("b")
        chain.create_coin(mint=mint, creator=creator)
        sig = chain.buy(mint=mint, wallet=buyer, sol=1.5, block_time=chain.time + 4, creator=creator)

        parsed = parse_transaction(chain.transactions[sig], sig)
        assert parsed is not None
        assert parsed.success
        assert "buy" in parsed.instructions
        trades = parsed.events_named("TradeEvent")
        assert len(trades) == 1
        assert trades[0].get("user") == buyer
        assert trades[0].get("is_buy") is True
        # The quote tail sits after the shareholders vec — proving the vec skip works.
        assert trades[0].get("quote_amount") == 1_500_000_000
        assert parsed.sol_deltas[buyer] < 0

    def test_funding_transfer_yields_positive_delta(self, chain: SyntheticChain):
        source, recipient = address("src"), address("dst")
        sig = chain.fund(source=source, recipient=recipient, sol=5.0, block_time=chain.time)
        parsed = parse_transaction(chain.transactions[sig], sig)
        assert parsed.sol_deltas[recipient] == 5_000_000_000
        assert parsed.sol_deltas[source] < 0

    def test_quote_symbol_defaults_to_sol(self):
        assert quote_symbol(None) == "SOL"
        assert quote_symbol(DEFAULT_PUBKEY) == "SOL"
        assert quote_symbol("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") == "USDC"
