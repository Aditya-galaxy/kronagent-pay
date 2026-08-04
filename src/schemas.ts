/**
 * Typed contracts for the payment path.
 *
 * The split that matters is between what an *agent* proposes and what the
 * platform *decides*. A `PaymentIntent` is a request: it can be produced by a
 * model that just read an attacker-controlled web page, so nothing in it is
 * trusted. A `PaymentDecision` is produced by deterministic code from that
 * intent plus the operator's standing mandates, and it is the only thing that
 * authorizes USDC to move.
 *
 * Note what `PaymentIntent` deliberately cannot express: a disposition. There
 * is no `approved` field for a model to set, no confidence score the engine
 * reads, no `urgent` flag that shortcuts review. The agent's entire influence
 * over the outcome is the counterparty, the amount, and a purpose string —
 * each of which the engine treats as hostile input. A test asserts those
 * fields never appear, so the property survives future edits.
 */

import type { Decimal } from './decimal';

/** Settlement networks. Testnets are the default so a misconfiguration spends play money. */
export type Chain =
  | 'base-sepolia'
  | 'base'
  | 'eth-sepolia'
  | 'ethereum'
  | 'polygon-amoy'
  | 'polygon';

/**
 * How the money moves. `x402` is the HTTP-native pay-per-request handshake
 * Circle's marketplace services speak; `gateway_deposit` funds the
 * Nanopayments gateway; `direct_transfer` is a plain USDC send.
 */
export type PaymentRail = 'x402' | 'gateway_deposit' | 'direct_transfer';

/** What an agent wants to pay, and why. Untrusted by construction. */
export interface PaymentIntent {
  readonly intentId: string;
  /** Wallet address, or the service/origin being paid via x402. */
  readonly counterparty: string;
  readonly amountUsdc: Decimal;
  readonly rail: PaymentRail;
  readonly chain: Chain;
  /** The 402-gated resource, when the rail is x402. */
  readonly resourceUrl?: string;
  /** Agent-supplied, shown to the human reading the approval queue. Never read by the engine. */
  readonly purpose?: string;
  readonly agentId: string;
  readonly requestedAt: string;
  /**
   * Whatever context the agent attached — the tool call, the service listing,
   * the page it was reading. Preserved so a human approving the payment sees
   * what the agent saw, and never consulted by the policy engine.
   */
  readonly context?: Record<string, unknown>;
}

export type Disposition = 'auto_pay' | 'requires_approval' | 'blocked';

/**
 * The deterministic verdict. `reason` is written for a human at 3am; `control`
 * is written for a machine, so the console can group by cause and an operator
 * can tell "over the cap" from "unknown counterparty" without parsing prose.
 */
export interface PaymentDecision {
  readonly intentId: string;
  readonly disposition: Disposition;
  readonly reason: string;
  readonly control: PolicyControl;
  readonly mandateId?: string;
  readonly decidedAt: string;
}

export type PolicyControl =
  | 'kill_switch'
  | 'mainnet_guard'
  | 'amount_unparseable'
  | 'absolute_cap'
  | 'no_mandate'
  | 'mandate_cap'
  | 'window_budget'
  | 'mandated';

/**
 * What actually happened on-chain, or what would have in dry-run.
 *
 * `txHash` plus `explorerUrl` are the difference between a claim and a
 * receipt — and they are literally the proof Circle's rules require: "the
 * agent's Circle wallet address and a clickable block-explorer URL".
 */
export interface PaymentOutcome {
  readonly intentId: string;
  readonly executed: boolean;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly txHash?: string;
  readonly explorerUrl?: string;
  readonly settledAt: string;
  readonly error?: string;
}

export function isAuthorized(decision: PaymentDecision): boolean {
  return decision.disposition === 'auto_pay';
}
