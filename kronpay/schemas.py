"""
Typed contracts for the payment path.

The split that matters is between what an *agent* proposes and what the
platform *decides*. A `PaymentIntent` is a request — it can be produced by an
LLM that read an attacker-controlled web page, so nothing in it is trusted. A
`PaymentDecision` is produced by deterministic code from the intent plus the
operator's standing mandates, and it is the only thing that can authorize
money leaving a wallet.

Note what a PaymentIntent deliberately cannot express: a disposition. There is
no `allow` field for a model to fill in, no confidence score the engine reads,
no "urgency" that shortcuts approval. The agent's entire influence over the
outcome is the counterparty, the amount, and a purpose string — every one of
which the engine treats as hostile input.
"""
# SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Aditya Kumar, trading as Kronagent · https://kronagent.com

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Chain(str, Enum):
    """Settlement networks. Testnet is the default everywhere so that a
    misconfiguration spends play money, not real money."""

    BASE_SEPOLIA = "base-sepolia"
    BASE = "base"
    ETH_SEPOLIA = "eth-sepolia"
    ETHEREUM = "ethereum"

    @property
    def is_testnet(self) -> bool:
        return self in {Chain.BASE_SEPOLIA, Chain.ETH_SEPOLIA}


class PaymentRail(str, Enum):
    """How the money moves. x402 is an HTTP-native pay-per-request handshake;
    a direct transfer is an ordinary USDC send with no request attached."""

    X402 = "x402"
    DIRECT_TRANSFER = "direct_transfer"


class PaymentIntent(BaseModel):
    """What an agent wants to pay, and why. Untrusted by construction."""

    model_config = ConfigDict(frozen=True)

    intent_id: str
    counterparty: str            # wallet address or x402 resource origin
    amount_usdc: Decimal         # USDC, not micro-units — six decimal places
    rail: PaymentRail = PaymentRail.X402
    chain: Chain = Chain.BASE_SEPOLIA
    resource_url: str = ""       # the 402-gated URL, when rail is x402
    purpose: str = ""            # agent-supplied, for the human reading the queue
    requested_at: str = Field(default_factory=utcnow_iso)
    agent_id: str = "default"
    # Free-form context the agent attached. Never read by the policy engine —
    # it exists so a human approving the payment can see what the agent saw.
    context: dict[str, Any] = Field(default_factory=dict)

    @field_validator("amount_usdc")
    @classmethod
    def _positive(cls, v: Decimal) -> Decimal:
        if v <= 0:
            raise ValueError("amount_usdc must be greater than zero")
        return v

    def as_audit_payload(self) -> dict[str, Any]:
        return {
            "intent_id": self.intent_id,
            "counterparty": self.counterparty,
            "amount_usdc": str(self.amount_usdc),
            "rail": self.rail.value,
            "chain": self.chain.value,
            "resource_url": self.resource_url,
            "purpose": self.purpose,
            "agent_id": self.agent_id,
        }


Disposition = Literal["auto_pay", "requires_approval", "blocked"]


class PaymentDecision(BaseModel):
    """The deterministic verdict. `reason` is written to be read by a human at
    3am, and by a judge reading an audit export six months later."""

    model_config = ConfigDict(frozen=True)

    intent_id: str
    disposition: Disposition
    reason: str
    # Which control produced this verdict — so an operator can tell "over the
    # per-payment cap" from "counterparty not mandated" without parsing prose.
    control: str
    mandate_id: Optional[str] = None
    decided_at: str = Field(default_factory=utcnow_iso)

    @property
    def authorizes_payment(self) -> bool:
        return self.disposition == "auto_pay"


class PaymentOutcome(BaseModel):
    """What actually happened on-chain, or what would have happened in dry-run.

    `tx_hash` is the difference between a claim and a receipt: it is the thing
    a judge, an auditor or a finance team can independently verify.
    """

    intent_id: str
    executed: bool
    dry_run: bool
    detail: str
    tx_hash: str = ""
    explorer_url: str = ""
    settled_at: str = Field(default_factory=utcnow_iso)
    error: str = ""
