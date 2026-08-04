/**
 * Hash-chained payment ledger.
 *
 * Every decision is recorded — including, especially, the refusals. A log of
 * what an agent *paid* tells you what happened; a log of what it *tried to
 * pay and was stopped from paying* is the one that tells you whether the
 * controls are working, and it is the only evidence that a prompt-injection
 * attempt was caught rather than never attempted.
 *
 * Each record carries the SHA-256 of the previous one, so editing or deleting
 * any past entry breaks verification of every entry after it. That matters
 * here more than in most systems: the party with the strongest motive to edit
 * the record is whoever caused the payment that shouldn't have happened.
 *
 * Append-only and hash-chained is not the same as immutable — someone with
 * write access can still truncate the file. It is *tamper-evident*, which is
 * the honest claim: you cannot alter history without the alteration being
 * detectable.
 */

import { createHash } from 'node:crypto';

import type { PaymentDecision, PaymentIntent, PaymentOutcome } from './schemas';

const GENESIS = '0'.repeat(64);

export type LedgerStage = 'decision' | 'settlement' | 'approval' | 'mandate';

export interface LedgerRecord {
  readonly stage: LedgerStage;
  readonly at: string;
  readonly payload: Record<string, unknown>;
}

export interface LedgerEnvelope {
  readonly prev: string;
  readonly hash: string;
  readonly record: LedgerRecord;
}

/**
 * Deterministic serialization the chain hash is computed over.
 *
 * Recursive, because the hash has to cover the payload's contents — that is
 * where the amount, the counterparty and the verdict live, and they are
 * exactly what someone would want to rewrite.
 *
 * Note for anyone tempted to shorten this: `JSON.stringify(obj, keys.sort())`
 * looks like it does the same job and does not. The second argument is a
 * replacer *allowlist applied at every level*, so top-level key names silently
 * filter out every nested key, and the payload hashes as empty. This code had
 * that bug; a tamper test caught it.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key]);
    return sorted;
  }
  return value;
}

function canonical(record: LedgerRecord): string {
  return JSON.stringify(canonicalize(record));
}

function hashEntry(prev: string, body: string): string {
  return createHash('sha256').update(`${prev}\n${body}`).digest('hex');
}

export class PaymentLedger {
  private readonly entries: LedgerEnvelope[] = [];
  private lastHash = GENESIS;

  append(stage: LedgerStage, payload: Record<string, unknown>, now: Date = new Date()): string {
    const record: LedgerRecord = { stage, at: now.toISOString(), payload };
    const hash = hashEntry(this.lastHash, canonical(record));
    this.entries.push({ prev: this.lastHash, hash, record });
    this.lastHash = hash;
    return hash;
  }

  /**
   * Record a verdict. Called for every decision, whatever it was — a held or
   * blocked payment is the more interesting record, not the less.
   */
  recordDecision(intent: PaymentIntent, decision: PaymentDecision, now?: Date): string {
    return this.append(
      'decision',
      {
        intentId: intent.intentId,
        agentId: intent.agentId,
        counterparty: intent.counterparty,
        amountUsdc: intent.amountUsdc.toString(),
        chain: intent.chain,
        rail: intent.rail,
        resourceUrl: intent.resourceUrl ?? '',
        // The agent's own words, preserved verbatim. Never an input to the
        // decision; kept so a human can see what the agent believed it was
        // doing, and so an injected instruction is visible in the record
        // rather than lost.
        purpose: intent.purpose ?? '',
        disposition: decision.disposition,
        control: decision.control,
        reason: decision.reason,
        mandateId: decision.mandateId ?? null,
      },
      now,
    );
  }

  recordSettlement(outcome: PaymentOutcome, now?: Date): string {
    return this.append(
      'settlement',
      {
        intentId: outcome.intentId,
        executed: outcome.executed,
        dryRun: outcome.dryRun,
        detail: outcome.detail,
        // The receipt. This is what makes the claim checkable by someone who
        // does not trust us — including a prize judge.
        txHash: outcome.txHash ?? '',
        explorerUrl: outcome.explorerUrl ?? '',
        error: outcome.error ?? '',
      },
      now,
    );
  }

  entriesView(): readonly LedgerEnvelope[] {
    return this.entries;
  }

  /** Records of a given stage, oldest first. */
  byStage(stage: LedgerStage): LedgerRecord[] {
    return this.entries.filter((e) => e.record.stage === stage).map((e) => e.record);
  }

  /**
   * Verify the whole chain. Returns the 1-based index of the first broken
   * entry, or null when intact.
   */
  verify(): { ok: boolean; brokenAt: number | null } {
    let prev = GENESIS;
    for (let i = 0; i < this.entries.length; i += 1) {
      const entry = this.entries[i]!;
      const recomputed = hashEntry(entry.prev, canonical(entry.record));
      if (entry.prev !== prev || entry.hash !== recomputed) {
        return { ok: false, brokenAt: i + 1 };
      }
      prev = entry.hash;
    }
    return { ok: true, brokenAt: null };
  }

  /** JSONL export — one envelope per line, for an auditor or a judge. */
  toJsonl(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n');
  }
}
