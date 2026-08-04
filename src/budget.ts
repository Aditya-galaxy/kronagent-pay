/**
 * Rolling-window spend budget.
 *
 * Per-payment caps stop one large theft. They do nothing about a thousand
 * small ones — and nanopayments are, by design, small and frequent, so the
 * drain attack against an agentic wallet is not a single $500 transfer but
 * five thousand payments of a tenth of a cent that each individually pass
 * every per-payment check. This is the control for that.
 *
 * Deliberately a *rolling* window rather than a calendar day: a fixed daily
 * reset hands an attacker a fresh budget at midnight and lets them spend two
 * full days' allowance in a few minutes either side of it.
 *
 * Only settled or in-flight payments count. A payment the policy engine held
 * for approval never consumed budget, so a burst of refused proposals cannot
 * exhaust an honest agent's allowance — which would otherwise turn the
 * injection attack into a denial-of-service against the thing defending
 * against it.
 */

import { Decimal } from './decimal';

export interface SpendRecord {
  readonly agentId: string;
  readonly amountUsdc: Decimal;
  /** Epoch millis. Held as a number so window arithmetic never re-parses. */
  readonly atMs: number;
  readonly intentId: string;
}

export interface BudgetLookupOptions {
  readonly agentId: string;
  readonly now?: Date;
}

export interface BudgetLedger {
  spentInWindow(options: BudgetLookupOptions): Decimal;
  windowCapUsdc(options: { agentId: string }): Decimal;
  windowLabel(): string;
}

export interface RollingBudgetOptions {
  /** Window length. 24h by default — long enough to be a real limit. */
  windowMs?: number;
  /** Default cap for any agent without a specific one. */
  defaultCapUsdc: Decimal | string;
  /** Per-agent overrides, so a high-volume agent isn't held to a pilot's cap. */
  perAgentCapUsdc?: Record<string, Decimal | string>;
}

const DAY_MS = 86_400_000;

export class RollingWindowBudget implements BudgetLedger {
  private readonly records: SpendRecord[] = [];
  private readonly windowMs: number;
  private readonly defaultCap: Decimal;
  private readonly perAgentCap: Map<string, Decimal>;

  constructor(options: RollingBudgetOptions) {
    this.windowMs = options.windowMs ?? DAY_MS;
    this.defaultCap = new Decimal(options.defaultCapUsdc);
    this.perAgentCap = new Map(
      Object.entries(options.perAgentCapUsdc ?? {}).map(([id, cap]) => [id, new Decimal(cap)]),
    );
  }

  /**
   * Record spend. Called only when a payment is actually attempted — the
   * decision to hold one for approval must not consume budget.
   */
  record(record: SpendRecord): void {
    this.records.push(record);
    this.prune(record.atMs);
  }

  spentInWindow(options: BudgetLookupOptions): Decimal {
    const nowMs = (options.now ?? new Date()).getTime();
    const cutoff = nowMs - this.windowMs;
    let total = new Decimal(0n);
    for (const record of this.records) {
      if (record.agentId !== options.agentId) continue;
      // Strictly greater: a record exactly at the boundary has aged out.
      if (record.atMs <= cutoff) continue;
      total = total.plus(record.amountUsdc);
    }
    return total;
  }

  windowCapUsdc(options: { agentId: string }): Decimal {
    return this.perAgentCap.get(options.agentId) ?? this.defaultCap;
  }

  remaining(options: BudgetLookupOptions): Decimal {
    const spent = this.spentInWindow(options);
    const cap = this.windowCapUsdc({ agentId: options.agentId });
    const left = cap.minus(spent);
    return left.isPositive() ? left : new Decimal(0n);
  }

  windowLabel(): string {
    const hours = this.windowMs / 3_600_000;
    if (Number.isInteger(hours)) return `${hours}h`;
    return `${Math.round(this.windowMs / 60_000)}m`;
  }

  /** Drop records that can no longer affect any window, so memory is bounded. */
  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    let drop = 0;
    while (drop < this.records.length && this.records[drop]!.atMs <= cutoff) drop += 1;
    if (drop > 0) this.records.splice(0, drop);
  }
}
