/**
 * Spend mandates — the delegated authority an agent transacts under.
 *
 * A mandate is an operator saying, on the record: *this agent may pay this
 * counterparty, up to this much per payment, until this date, and I am the one
 * accountable for that.* It is the unit that turns "the agent asked a human
 * every time" into "the agent runs unattended within rules", which is the
 * difference between a confirm dialog and autonomy.
 *
 * Four properties, each load-bearing:
 *
 *   **It expires.** A mandate without a TTL is standing authority nobody will
 *   ever be asked to reconfirm. A periodic review fails open — silence reads
 *   as approval, the entry survives because nobody got to it. An expiry fails
 *   closed: the authority lapses unless a named person actively renews it, so
 *   inattention withdraws spending power instead of extending it. This is the
 *   single most important design decision in the file.
 *
 *   **It has an owner.** Separate from who issued it. The issuer made a
 *   decision on a date that nothing later changes; the owner is who is
 *   accountable *now* and gets asked at renewal. People change teams; the
 *   decision they made in March does not. Reassigning ownership moves the
 *   former and never rewrites the latter.
 *
 *   **It is per-counterparty.** Not a global spend limit. An agent with a
 *   $10 daily budget and no counterparty restriction can send $10 to an
 *   attacker; the same budget scoped to mandated services cannot.
 *
 *   **It records why.** The reason an operator gave for granting it, kept
 *   verbatim, because six months on that sentence is the only thing that can
 *   answer "should this still exist?"
 *
 * Expiry is enforced in `liveMandateFor` — the same read the policy engine
 * makes on every decision — so a lapse takes effect immediately and does not
 * depend on any sweep, cron or restart having run.
 */

import { Decimal } from './decimal';

export interface Mandate {
  readonly mandateId: string;
  /** Wallet address or x402 service origin this mandate authorizes paying. */
  readonly counterparty: string;
  /** Which agent may spend under it. `*` authorizes every agent. */
  readonly agentId: string;
  readonly maxPerPaymentUsdc: Decimal;
  /** Immutable history: who granted this authority, and when. */
  readonly issuedBy: string;
  readonly issuedAt: string;
  /** Verbatim justification, for whoever later asks whether it still applies. */
  readonly reason: string;
  /** Mutable: who is accountable now and gets asked to renew. */
  owner: string;
  /** ISO timestamp. `undefined` means standing authority — reported as such. */
  readonly expiresAt?: string;
  /** Usage evidence. A mandate that never fires is authority with no benefit. */
  lastUsedAt?: string;
  useCount: number;
}

/** The narrow read the policy engine depends on. */
export interface MandateView {
  readonly mandateId: string;
  readonly counterparty: string;
  readonly maxPerPaymentUsdc: Decimal;
}

export interface MandateLookupOptions {
  readonly agentId: string;
  readonly now?: Date;
}

export function isExpired(mandate: Mandate, now: Date = new Date()): boolean {
  if (!mandate.expiresAt) return false;
  const expiry = Date.parse(mandate.expiresAt);
  // A corrupt expiry must not read as "never expires" — that would turn a
  // typo into permanent spending authority. Fail closed: treat it as lapsed.
  if (Number.isNaN(expiry)) return true;
  return now.getTime() >= expiry;
}

/** True once a mandate has gone unused long enough to be worth questioning. */
export function isStale(mandate: Mandate, afterDays = 30, now: Date = new Date()): boolean {
  const reference = Date.parse(mandate.lastUsedAt ?? mandate.issuedAt);
  if (Number.isNaN(reference)) return false;
  return now.getTime() - reference >= afterDays * 86_400_000;
}

/**
 * In-memory mandate store.
 *
 * Persistence and the audited issue/revoke path land on top of this; the
 * lookup the policy engine uses is kept synchronous and side-effect free so
 * the decision path never waits on I/O and never mutates state while deciding.
 */
export class MandateStore {
  private readonly mandates = new Map<string, Mandate>();

  constructor(initial: Mandate[] = []) {
    for (const mandate of initial) this.mandates.set(mandate.mandateId, mandate);
  }

  /**
   * The live mandate authorizing this agent to pay this counterparty, or
   * `undefined`. Expired mandates are not live: the check happens here, at the
   * gate, so autonomy lapses on the very next decision.
   *
   * When several mandates match, the *most restrictive* cap wins. An operator
   * who issued a tight mandate and later a loose one has not implicitly
   * revoked the tight one, and reading it any other way would let a duplicate
   * silently raise a limit.
   */
  liveMandateFor(counterparty: string, options: MandateLookupOptions): MandateView | undefined {
    const now = options.now ?? new Date();
    let chosen: Mandate | undefined;

    for (const mandate of this.mandates.values()) {
      if (mandate.counterparty !== counterparty) continue;
      if (mandate.agentId !== '*' && mandate.agentId !== options.agentId) continue;
      if (isExpired(mandate, now)) continue;
      if (!chosen || mandate.maxPerPaymentUsdc.lte(chosen.maxPerPaymentUsdc)) {
        chosen = mandate;
      }
    }
    return chosen;
  }

  /** Every mandate, expired included — a review has to see a lapsed one to renew it. */
  list(): Mandate[] {
    return [...this.mandates.values()].sort((a, b) => a.counterparty.localeCompare(b.counterparty));
  }

  active(now: Date = new Date()): Mandate[] {
    return this.list().filter((m) => !isExpired(m, now));
  }

  expired(now: Date = new Date()): Mandate[] {
    return this.list().filter((m) => isExpired(m, now));
  }

  get(mandateId: string): Mandate | undefined {
    return this.mandates.get(mandateId);
  }

  put(mandate: Mandate): void {
    this.mandates.set(mandate.mandateId, mandate);
  }

  delete(mandateId: string): boolean {
    return this.mandates.delete(mandateId);
  }

  /**
   * Note that a mandate authorized a payment. Not an audit event — the payment
   * itself is already on the ledger, and mirroring every use into the
   * governance record would bury the issue/revoke/expire decisions that record
   * exists to make findable. This is usage evidence for review.
   */
  recordUse(mandateId: string, now: Date = new Date()): void {
    const mandate = this.mandates.get(mandateId);
    if (!mandate) return;
    mandate.lastUsedAt = now.toISOString();
    mandate.useCount += 1;
  }
}

export interface IssueMandateInput {
  counterparty: string;
  maxPerPaymentUsdc: Decimal | string;
  issuedBy: string;
  reason: string;
  agentId?: string;
  /** Defaults to the issuer: whoever grants authority owns it until they hand it over. */
  owner?: string;
  expiresInDays?: number;
  now?: Date;
}

export function issueMandate(input: IssueMandateInput): Mandate {
  const now = input.now ?? new Date();
  const expiresAt =
    input.expiresInDays === undefined
      ? undefined
      : new Date(now.getTime() + input.expiresInDays * 86_400_000).toISOString();

  return {
    mandateId: `mdt-${globalThis.crypto.randomUUID().slice(0, 12)}`,
    counterparty: input.counterparty,
    agentId: input.agentId ?? '*',
    maxPerPaymentUsdc: new Decimal(input.maxPerPaymentUsdc),
    issuedBy: input.issuedBy,
    issuedAt: now.toISOString(),
    reason: input.reason,
    owner: input.owner ?? input.issuedBy,
    expiresAt,
    useCount: 0,
  };
}
