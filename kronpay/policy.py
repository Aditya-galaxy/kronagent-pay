"""
The payment policy engine — the gate between "an agent asked to pay" and
"money left the wallet".

x402 answers *how* an agent pays. This answers *whether it should*, and it is
the only part of the system permitted to say yes.

Deliberately pure, deterministic logic over the intent and the operator's
standing mandates. No LLM, no network, no clock skew, no configurable
"strictness" — so its decisions cannot be influenced by prompt injection in a
web page the agent read, by a merchant's response body, or by anything else an
attacker controls. That property is the entire product. An agent that can be
talked into proposing a payment is expected and survivable; an engine that can
be talked into approving one is not.

Decision procedure, in order, first match wins:

  1. Kill switch engaged              -> blocked
  2. Chain is mainnet, mainnet not
     explicitly armed                 -> blocked   (fail closed on real money)
  3. Amount over the absolute
     per-payment ceiling              -> requires_approval
  4. No live mandate for the
     counterparty                     -> requires_approval
  5. Amount over that mandate's
     per-payment cap                  -> requires_approval
  6. Payment would breach the rolling
     window budget                    -> requires_approval
  7. Otherwise                        -> auto_pay

Every path that is not an explicit, in-budget, in-mandate match lands on a
human. There is no branch that fails open: an unreadable mandate, an unknown
counterparty, an unparseable amount and a missing budget ledger all converge on
`requires_approval`, because the cost of a wrongly-queued payment is a person's
attention and the cost of a wrongly-sent one is irreversible.

**Irreversibility is why this is stricter than a containment policy.** A
security action like isolating an instance can be rolled back; a settled USDC
transfer cannot. There is no equivalent of "restore the original security
group" for money that has arrived at an attacker's address, so the ceiling here
is a hard cap rather than a reversibility test.
"""
# SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Aditya Kumar, trading as Kronagent · https://kronagent.com

from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Optional, Protocol

from .schemas import PaymentDecision, PaymentIntent


class MandateLookup(Protocol):
    """What the engine needs from a mandate store, kept narrow so the engine
    can be tested against a dict and never has to touch disk."""

    def live_mandate_for(
        self, counterparty: str, *, agent_id: str, now: Optional[datetime] = None
    ) -> Optional["MandateView"]: ...


class MandateView(Protocol):
    """The read-only face of a spend mandate."""

    mandate_id: str
    counterparty: str
    max_per_payment_usdc: Decimal


class BudgetLookup(Protocol):
    def spent_in_window(self, *, agent_id: str, now: Optional[datetime] = None) -> Decimal: ...
    def window_cap_usdc(self, *, agent_id: str) -> Decimal: ...
    def window_label(self) -> str: ...


class PaymentPolicySettings:
    """Safety controls, defaulting to the values that cannot lose money.

    `dry_run` and `kill_switch` mirror Kronagent's controls deliberately: an
    operator who knows one system knows the other, and the muscle memory for
    stopping it transfers.
    """

    def __init__(
        self,
        *,
        dry_run: bool = True,
        kill_switch: bool = False,
        # The ceiling no mandate can raise. A mandate is a delegation of the
        # operator's authority; this is the limit on the authority itself.
        absolute_max_per_payment_usdc: Decimal = Decimal("1.00"),
        # Mainnet requires a second, explicit opt-in beyond turning off
        # dry-run, so "I turned off dry-run to test" cannot spend real money.
        allow_mainnet: bool = False,
    ) -> None:
        self.dry_run = dry_run
        self.kill_switch = kill_switch
        self.absolute_max_per_payment_usdc = absolute_max_per_payment_usdc
        self.allow_mainnet = allow_mainnet


class PaymentPolicyEngine:
    def __init__(
        self,
        settings: PaymentPolicySettings,
        mandates: MandateLookup,
        budget: BudgetLookup,
    ) -> None:
        self._settings = settings
        self._mandates = mandates
        self._budget = budget

    def decide(
        self, intent: PaymentIntent, *, now: Optional[datetime] = None
    ) -> PaymentDecision:
        s = self._settings

        if s.kill_switch:
            return PaymentDecision(
                intent_id=intent.intent_id, disposition="blocked", control="kill_switch",
                reason="kill switch engaged — no payment may leave the wallet",
            )

        if not intent.chain.is_testnet and not s.allow_mainnet:
            return PaymentDecision(
                intent_id=intent.intent_id, disposition="blocked", control="mainnet_guard",
                reason=(f"{intent.chain.value} is a mainnet and mainnet spending is not "
                        f"armed — set allow_mainnet explicitly, turning off dry-run is "
                        f"not enough"),
            )

        try:
            amount = Decimal(intent.amount_usdc)
        except (InvalidOperation, TypeError, ValueError):
            # Unreachable through the model's own validation; kept because the
            # failure mode of guessing at an amount is unbounded.
            return PaymentDecision(
                intent_id=intent.intent_id, disposition="requires_approval",
                control="amount_unparseable",
                reason="amount could not be read as a number — a human decides",
            )

        if amount > s.absolute_max_per_payment_usdc:
            return PaymentDecision(
                intent_id=intent.intent_id, disposition="requires_approval",
                control="absolute_cap",
                reason=(f"{amount} USDC is over the absolute per-payment ceiling of "
                        f"{s.absolute_max_per_payment_usdc} USDC — no mandate can raise "
                        f"this, only a human can authorize it"),
            )

        mandate = self._mandates.live_mandate_for(
            intent.counterparty, agent_id=intent.agent_id, now=now
        )
        if mandate is None:
            return PaymentDecision(
                intent_id=intent.intent_id, disposition="requires_approval",
                control="no_mandate",
                reason=(f"no live spend mandate for {intent.counterparty} — the agent may "
                        f"propose paying anyone, but it may only pay counterparties an "
                        f"operator has mandated, and mandates expire"),
            )

        if amount > mandate.max_per_payment_usdc:
            return PaymentDecision(
                intent_id=intent.intent_id, disposition="requires_approval",
                control="mandate_cap", mandate_id=mandate.mandate_id,
                reason=(f"{amount} USDC exceeds the {mandate.max_per_payment_usdc} USDC "
                        f"per-payment cap on the mandate for {intent.counterparty}"),
            )

        spent = self._budget.spent_in_window(agent_id=intent.agent_id, now=now)
        cap = self._budget.window_cap_usdc(agent_id=intent.agent_id)
        if spent + amount > cap:
            return PaymentDecision(
                intent_id=intent.intent_id, disposition="requires_approval",
                control="window_budget", mandate_id=mandate.mandate_id,
                reason=(f"{amount} USDC would take spending to {spent + amount} USDC in the "
                        f"{self._budget.window_label()} window, over the {cap} USDC budget — "
                        f"individually small payments still add up to a drained wallet"),
            )

        return PaymentDecision(
            intent_id=intent.intent_id, disposition="auto_pay",
            control="mandated", mandate_id=mandate.mandate_id,
            reason=(f"{amount} USDC to {intent.counterparty} is within the mandate cap "
                    f"({mandate.max_per_payment_usdc} USDC) and the {self._budget.window_label()} "
                    f"budget ({spent + amount} of {cap} USDC)"),
        )
