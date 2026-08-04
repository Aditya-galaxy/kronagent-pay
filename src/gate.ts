/**
 * The payment gate — a drop-in replacement for Circle's approval prompt.
 *
 * Circle's starter kits define one seam for spend control:
 *
 *     type ApprovalFn = (toolName: string, args: unknown) => Promise<boolean>;
 *
 * and wire it into the ADK's `beforeToolCallback` (LangChain's `interruptOn`,
 * the Claude Agent SDK's `canUseTool` — same idea, three frameworks). Their
 * implementation prints the pending call and asks a human `y/N` in the
 * terminal, every single time.
 *
 * That is a confirm dialog, not autonomy. It cannot run unattended, it leaves
 * no record beyond terminal scrollback, and it gives an operator no way to
 * express "payments under five cents to this service are fine for the next
 * thirty days". Circle's own prize rules rule it out: *the payment must be
 * genuinely agent-driven — a human manually completing checkout does not
 * qualify.*
 *
 * This implements the same function against standing mandates instead. Same
 * seam, same one-line integration, opposite properties: the agent runs
 * unattended *within rules an operator set in advance*, and every decision —
 * including every refusal — lands on a hash-chained ledger.
 *
 * ## Pricing before authorizing
 *
 * `circle_pay_service` takes a URL and no amount: the price comes from the
 * service's own x402 payment requirements. So the gate cannot decide anything
 * until it has priced the call, and it resolves the price itself rather than
 * trusting a number the agent supplied — the agent read the service listing,
 * and the listing is attacker-influenced input.
 *
 * If pricing fails, the payment is held, not attempted. You cannot authorize
 * what you have not priced, and "the price lookup failed so we paid anyway"
 * is not a sentence anyone wants in an incident review.
 */

import { Decimal } from './decimal';
import type { BudgetLedger } from './budget';
import type { MandateStore } from './mandates';
import type { PaymentLedger } from './ledger';
import type { PaymentPolicyEngine } from './policy';
import type { Chain, PaymentIntent, PaymentRail } from './schemas';

/** The tools in Circle's kit that move USDC. Everything else runs unimpeded. */
export const SPEND_TOOLS = ['circle_pay_service', 'circle_gateway_deposit'] as const;
export type SpendTool = (typeof SPEND_TOOLS)[number];

const SPEND_TOOL_SET: ReadonlySet<string> = new Set(SPEND_TOOLS);

/** What the gate learns about a call before it decides. */
export interface PriceQuote {
  readonly amountUsdc: Decimal;
  readonly chain: Chain;
  /** The counterparty a mandate is matched against — service origin or address. */
  readonly counterparty: string;
}

/**
 * Resolves what a call will actually cost. In production this shells out to
 * `circle services pay --estimate`, which returns the payment requirements
 * without paying; in tests it is a stub. Injected so the decision path has no
 * hard dependency on the CLI.
 */
export type PriceResolver = (toolName: SpendTool, args: Record<string, unknown>) => Promise<PriceQuote>;

/** Where held payments go to wait for a human. */
export interface ApprovalQueue {
  enqueue(intent: PaymentIntent, reason: string): Promise<void> | void;
}

export interface PaymentGateOptions {
  engine: PaymentPolicyEngine;
  mandates: MandateStore;
  budget: { record(r: { agentId: string; amountUsdc: Decimal; atMs: number; intentId: string }): void } & BudgetLedger;
  ledger: PaymentLedger;
  resolvePrice: PriceResolver;
  approvals?: ApprovalQueue;
  agentId?: string;
  /** Injected for deterministic tests; defaults to the wall clock. */
  now?: () => Date;
  /** Surfaced to the operator's console/terminal. Defaults to silence. */
  log?: (line: string) => void;
}

let intentCounter = 0;
function nextIntentId(): string {
  intentCounter += 1;
  return `pi-${Date.now().toString(36)}-${intentCounter}`;
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

/**
 * Build the ApprovalFn. Pass it straight to the kit:
 *
 *     const agent = buildAgent(config, createPaymentGate({...}), ask);
 */
export function createPaymentGate(options: PaymentGateOptions) {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const agentId = options.agentId ?? 'default';

  return async function paymentGate(toolName: string, args: unknown): Promise<boolean> {
    // Read-only tools — wallet list, balance, service search, skill fetch —
    // are none of our business. Gating them would slow the agent down and
    // protect nothing.
    if (!SPEND_TOOL_SET.has(toolName)) return true;

    const at = now();
    const argRecord = asRecord(args);

    let quote: PriceQuote;
    try {
      quote = await options.resolvePrice(toolName as SpendTool, argRecord);
    } catch (error) {
      // Fail closed. An unpriced payment is an unbounded one.
      const message = error instanceof Error ? error.message : String(error);
      const intent = buildIntent(argRecord, {
        amountUsdc: new Decimal(0n),
        chain: 'base-sepolia',
        counterparty: String(argRecord['url'] ?? argRecord['address'] ?? 'unknown'),
      }, toolName, agentId, at);

      options.ledger.recordDecision(intent, {
        intentId: intent.intentId,
        disposition: 'requires_approval',
        control: 'amount_unparseable',
        reason: `could not price this call (${message}) — held, because an unpriced payment is an unbounded one`,
        decidedAt: at.toISOString(),
      }, at);
      log(`HELD ${toolName}: price discovery failed — ${message}`);
      await options.approvals?.enqueue(intent, `price discovery failed: ${message}`);
      return false;
    }

    const intent = buildIntent(argRecord, quote, toolName, agentId, at);
    const decision = options.engine.decide(intent, at);
    options.ledger.recordDecision(intent, decision, at);

    if (decision.disposition === 'auto_pay') {
      // Budget is consumed at authorization, not at settlement: two payments
      // authorized in the same instant must not both see the pre-spend total.
      options.budget.record({
        agentId: intent.agentId,
        amountUsdc: intent.amountUsdc,
        atMs: at.getTime(),
        intentId: intent.intentId,
      });
      if (decision.mandateId) options.mandates.recordUse(decision.mandateId, at);
      log(`PAID ${intent.amountUsdc} USDC → ${intent.counterparty} (${decision.control})`);
      return true;
    }

    log(`${decision.disposition === 'blocked' ? 'BLOCKED' : 'HELD'} ${intent.amountUsdc} USDC → ${intent.counterparty}: ${decision.reason}`);
    if (decision.disposition === 'requires_approval') {
      await options.approvals?.enqueue(intent, decision.reason);
    }
    return false;
  };
}

function buildIntent(
  args: Record<string, unknown>,
  quote: PriceQuote,
  toolName: string,
  agentId: string,
  at: Date,
): PaymentIntent {
  const rail: PaymentRail = toolName === 'circle_gateway_deposit' ? 'gateway_deposit' : 'x402';
  return {
    intentId: nextIntentId(),
    counterparty: quote.counterparty,
    amountUsdc: quote.amountUsdc,
    rail,
    chain: quote.chain,
    resourceUrl: typeof args['url'] === 'string' ? args['url'] : undefined,
    // The agent's payload, kept for the human reading the queue. The engine
    // never reads it — an injected instruction sitting in here is evidence,
    // not input.
    purpose: typeof args['dataJson'] === 'string' ? args['dataJson'] : undefined,
    agentId,
    requestedAt: at.toISOString(),
    context: { tool: toolName, args },
  };
}
