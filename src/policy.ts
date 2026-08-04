/**
 * The payment policy engine — the gate between "the agent asked to pay" and
 * "USDC left the wallet".
 *
 * Circle's Agent Stack answers *how* an agent pays. Its reference kits answer
 * *whether* with a terminal `y/N` prompt on every spend. That is a confirm
 * dialog, not autonomy: it cannot run unattended, it leaves no record beyond
 * scrollback, and it gives an operator no way to say "payments under $0.05 to
 * this service are fine for the next 30 days".
 *
 * This replaces the prompt. The operator issues *mandates* ahead of time; the
 * engine applies them to every proposed payment, deterministically.
 *
 * Deterministic is the load-bearing word. No LLM, no network call, no
 * configurable strictness — so the verdict cannot be influenced by a web page
 * the agent read, by a merchant's response body, or by anything else an
 * attacker controls. An agent that can be talked into *proposing* a payment is
 * expected and survivable. An engine that can be talked into *approving* one
 * is not.
 *
 * Order of evaluation, first match wins:
 *
 *   1. Kill switch engaged                     -> blocked
 *   2. Mainnet, not explicitly armed           -> blocked
 *   3. Amount over the absolute ceiling        -> requires_approval
 *   4. No live mandate for the counterparty    -> requires_approval
 *   5. Over that mandate's per-payment cap     -> requires_approval
 *   6. Would breach the rolling window budget  -> requires_approval
 *   7. Otherwise                               -> auto_pay
 *
 * Nothing fails open. An unknown counterparty, an expired mandate, an
 * unparseable amount and a missing budget all converge on a human, because a
 * wrongly-held payment costs someone's attention and a wrongly-sent one is
 * irreversible. That asymmetry is why the ceiling here is a hard cap rather
 * than the reversibility test a containment system can afford: there is no
 * "undo" for USDC that has arrived at an attacker's address.
 */

import { Decimal } from './decimal';
import type { MandateStore, MandateView } from './mandates';
import type { BudgetLedger } from './budget';
import type { PaymentDecision, PaymentIntent } from './schemas';

export interface PaymentPolicySettings {
  /** Plan and record, never settle. The default everywhere. */
  dryRun: boolean;
  /** One switch that stops all spending, mandates notwithstanding. */
  killSwitch: boolean;
  /**
   * The ceiling no mandate can raise. A mandate delegates the operator's
   * authority; this bounds the authority itself, so a fat-fingered cap of
   * 1000 USDC in a mandate does not arm a 1000 USDC payment.
   */
  absoluteMaxPerPaymentUsdc: Decimal;
  /**
   * Mainnet needs a second, explicit opt-in beyond turning off dry-run — so
   * "I disabled dry-run to test something" can never spend real money.
   */
  allowMainnet: boolean;
}

export const SAFE_DEFAULTS: PaymentPolicySettings = {
  dryRun: true,
  killSwitch: false,
  absoluteMaxPerPaymentUsdc: new Decimal('1.00'),
  allowMainnet: false,
};

const TESTNETS = new Set(['base-sepolia', 'eth-sepolia', 'polygon-amoy']);

export function isTestnet(chain: string): boolean {
  return TESTNETS.has(chain.toLowerCase());
}

export class PaymentPolicyEngine {
  constructor(
    private readonly settings: PaymentPolicySettings,
    private readonly mandates: MandateStore,
    private readonly budget: BudgetLedger,
  ) {}

  decide(intent: PaymentIntent, now: Date = new Date()): PaymentDecision {
    const s = this.settings;
    const base = { intentId: intent.intentId, decidedAt: now.toISOString() };

    if (s.killSwitch) {
      return {
        ...base,
        disposition: 'blocked',
        control: 'kill_switch',
        reason: 'kill switch engaged — no payment may leave the wallet',
      };
    }

    if (!isTestnet(intent.chain) && !s.allowMainnet) {
      return {
        ...base,
        disposition: 'blocked',
        control: 'mainnet_guard',
        reason:
          `${intent.chain} is a mainnet and mainnet spending is not armed — ` +
          `this requires an explicit opt-in, turning off dry-run is not enough`,
      };
    }

    let amount: Decimal;
    try {
      amount = new Decimal(intent.amountUsdc);
    } catch {
      // Should be unreachable — intents are validated on construction — but
      // the failure mode of guessing at an amount is unbounded, so it lands
      // on a human rather than a default.
      return {
        ...base,
        disposition: 'requires_approval',
        control: 'amount_unparseable',
        reason: 'amount could not be read as a number — a human decides',
      };
    }

    if (amount.gt(s.absoluteMaxPerPaymentUsdc)) {
      return {
        ...base,
        disposition: 'requires_approval',
        control: 'absolute_cap',
        reason:
          `${amount} USDC is over the absolute per-payment ceiling of ` +
          `${s.absoluteMaxPerPaymentUsdc} USDC — no mandate can raise this, ` +
          `only a human can authorize it`,
      };
    }

    const mandate: MandateView | undefined = this.mandates.liveMandateFor(
      intent.counterparty,
      { agentId: intent.agentId, now },
    );

    if (!mandate) {
      return {
        ...base,
        disposition: 'requires_approval',
        control: 'no_mandate',
        reason:
          `no live spend mandate for ${intent.counterparty} — the agent may propose ` +
          `paying anyone, but it may only pay counterparties an operator has ` +
          `mandated, and mandates expire`,
      };
    }

    if (amount.gt(mandate.maxPerPaymentUsdc)) {
      return {
        ...base,
        disposition: 'requires_approval',
        control: 'mandate_cap',
        mandateId: mandate.mandateId,
        reason:
          `${amount} USDC exceeds the ${mandate.maxPerPaymentUsdc} USDC per-payment ` +
          `cap on the mandate for ${intent.counterparty}`,
      };
    }

    const spent = this.budget.spentInWindow({ agentId: intent.agentId, now });
    const cap = this.budget.windowCapUsdc({ agentId: intent.agentId });
    const after = spent.plus(amount);

    if (after.gt(cap)) {
      return {
        ...base,
        disposition: 'requires_approval',
        control: 'window_budget',
        mandateId: mandate.mandateId,
        reason:
          `${amount} USDC would take spending to ${after} USDC in the ` +
          `${this.budget.windowLabel()} window, over the ${cap} USDC budget — ` +
          `individually small payments still add up to a drained wallet`,
      };
    }

    return {
      ...base,
      disposition: 'auto_pay',
      control: 'mandated',
      mandateId: mandate.mandateId,
      reason:
        `${amount} USDC to ${intent.counterparty} is within the mandate cap ` +
        `(${mandate.maxPerPaymentUsdc} USDC) and the ${this.budget.windowLabel()} ` +
        `budget (${after} of ${cap} USDC)`,
    };
  }
}
