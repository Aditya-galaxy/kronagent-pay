/**
 * Campaign state as an append-only log, with the hash chain derived rather
 * than maintained.
 *
 * The previous design wrote the whole store to one blob. That is durable and
 * it is not safe: two concurrent passes each load, decide and save, and the
 * second overwrites the first. A payout could disappear from the record while
 * having actually settled — the money moved, the ledger forgot, and the next
 * pass would consider those views unpaid.
 *
 * **One object per event fixes it.** Concurrent writers touch different keys,
 * so nothing is clobbered. State is derived by replaying the log rather than
 * read from a snapshot.
 *
 * ## Two things about the key
 *
 * It is `<iso timestamp>__<event id>`. The timestamp is a *prefix* because
 * object stores list lexicographically, so sorting by key sorts by time. The
 * event id carries the uniqueness, and for payouts it is the same
 * deterministic `pay-<submission>-<views>` used as Circle's idempotency key —
 * so two passes producing the same payout produce the same key, and the
 * duplicate is a no-op instead of a second record.
 *
 * A timestamp alone would be wrong: two events inside one millisecond collide.
 * Identity — an email or a handle — would also be wrong, and worse: object
 * keys land in access logs, bucket listings and stack traces, which is not
 * somewhere to put a person's address.
 *
 * ## Why the chain is computed on read
 *
 * A hash chain has a single-writer assumption baked in — entry *n* hashes
 * entry *n−1*, so two concurrent appends both claim the same predecessor and
 * the chain forks. A queue does not fix that; it makes the fork visible rather
 * than silent.
 *
 * So nothing writes chain links. Events are *facts*, and the chain is a
 * function over them: list, sort, hash forward. Nobody has to be the single
 * writer because nobody is writing links at all.
 *
 * Tamper-evidence is unchanged — altering or removing any event changes every
 * hash after it. What is gained is that **anyone can recompute the chain
 * independently**, which is strictly better for the audit argument: a verifier
 * no longer has to trust that we linked the entries honestly.
 *
 * The cost is O(n) on read instead of O(1) on append. At hundreds of events
 * that is microseconds. The scaling answer is a periodic checkpointed root
 * with only the tail replayed, and it is not needed yet.
 */

import { createHash } from 'node:crypto';

import { Decimal } from '../decimal';
import type { Campaign, Creator, Payout, Snapshot, Submission, Verdict } from './types';

export const EVENT_VERSION = 1;

/** Everything that can change campaign state. Each is a fact, already true. */
export type CampaignEvent =
  | { readonly type: 'campaign_upserted'; readonly campaign: Campaign }
  | { readonly type: 'creator_upserted'; readonly creator: Creator }
  | { readonly type: 'submission_accepted'; readonly submission: Submission }
  | { readonly type: 'verdict_recorded'; readonly verdict: Verdict }
  | { readonly type: 'snapshot_taken'; readonly snapshot: Snapshot }
  | { readonly type: 'payout_settled'; readonly payout: Payout };

export interface EventEnvelope {
  readonly version: number;
  /** Unique, and deterministic wherever the underlying fact is. */
  readonly eventId: string;
  readonly at: string;
  readonly event: CampaignEvent;
}

/**
 * The id for an event.
 *
 * Deterministic for payouts and snapshots — the two that a concurrent pass
 * could genuinely produce twice — so a repeat write collides with itself
 * rather than creating a duplicate record.
 */
export function eventIdFor(event: CampaignEvent, at: string): string {
  switch (event.type) {
    case 'payout_settled':
      return event.payout.payoutId;
    case 'snapshot_taken':
      return `snap-${event.snapshot.submissionId}-${event.snapshot.fetchedAt}`;
    case 'verdict_recorded':
      return `vdt-${event.verdict.verdictId}`;
    case 'submission_accepted':
      return `sub-${event.submission.submissionId}`;
    case 'creator_upserted':
      return `cre-${event.creator.creatorId}-${at}`;
    case 'campaign_upserted':
      return `cmp-${event.campaign.campaignId}-${at}`;
  }
}

/** Object keys must sort by time, so the timestamp leads. */
export function keyFor(envelope: EventEnvelope): string {
  const stamp = envelope.at.replace(/[:.]/g, '-');
  const safeId = envelope.eventId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `events/${stamp}__${safeId}.json`;
}

/* ────────────────────────── serialisation ──────────────────────────
   Money and view counts are bigint and must never touch a JSON number.
   A precision bug here would be invisible to every arithmetic test: the
   maths would be right and the value would change on the way to storage. */

const encCampaign = (c: Campaign) => ({
  ...c,
  poolUsdc: c.poolUsdc.toString(),
  cpmUsdc: c.cpmUsdc.toString(),
  perCreatorCapUsdc: c.perCreatorCapUsdc.toString(),
  rateBand: { minUsdc: c.rateBand.minUsdc.toString(), maxUsdc: c.rateBand.maxUsdc.toString() },
});

const encSubmission = (s: Submission) => ({
  ...s,
  acceptedTerms: {
    ...s.acceptedTerms,
    cpmUsdc: s.acceptedTerms.cpmUsdc.toString(),
    perCreatorCapUsdc: s.acceptedTerms.perCreatorCapUsdc.toString(),
  },
});

export function encodeEvent(envelope: EventEnvelope): string {
  const e = envelope.event;
  let payload: unknown;
  switch (e.type) {
    case 'campaign_upserted':
      payload = { type: e.type, campaign: encCampaign(e.campaign) };
      break;
    case 'creator_upserted':
      payload = e;
      break;
    case 'submission_accepted':
      payload = { type: e.type, submission: encSubmission(e.submission) };
      break;
    case 'verdict_recorded':
      payload = e;
      break;
    case 'snapshot_taken':
      payload = { type: e.type, snapshot: { ...e.snapshot, views: e.snapshot.views.toString() } };
      break;
    case 'payout_settled':
      payload = {
        type: e.type,
        payout: {
          ...e.payout,
          viewsPaidTo: e.payout.viewsPaidTo.toString(),
          amountUsdc: e.payout.amountUsdc.toString(),
        },
      };
      break;
  }
  return JSON.stringify(
    { version: envelope.version, eventId: envelope.eventId, at: envelope.at, event: payload },
    null,
    2,
  );
}

export function decodeEvent(raw: string): EventEnvelope {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.version !== EVENT_VERSION) {
    throw new RangeError(
      `event is version ${String(parsed.version)}, this build reads ${EVENT_VERSION} — ` +
        'refusing rather than replaying a fact it only partly understands',
    );
  }
  const e = parsed.event as Record<string, unknown>;
  const type = String(e.type);

  let event: CampaignEvent;
  if (type === 'campaign_upserted') {
    const c = e.campaign as Record<string, unknown>;
    const band = (c.rateBand ?? {}) as Record<string, string>;
    event = {
      type,
      campaign: {
        ...(c as unknown as Campaign),
        poolUsdc: new Decimal(String(c.poolUsdc)),
        cpmUsdc: new Decimal(String(c.cpmUsdc)),
        perCreatorCapUsdc: new Decimal(String(c.perCreatorCapUsdc)),
        rateBand: {
          minUsdc: new Decimal(String(band.minUsdc)),
          maxUsdc: new Decimal(String(band.maxUsdc)),
        },
      },
    };
  } else if (type === 'submission_accepted') {
    const s = e.submission as Record<string, unknown>;
    const t = (s.acceptedTerms ?? {}) as Record<string, unknown>;
    event = {
      type,
      submission: {
        ...(s as unknown as Submission),
        acceptedTerms: {
          ...(t as unknown as Submission['acceptedTerms']),
          cpmUsdc: new Decimal(String(t.cpmUsdc)),
          perCreatorCapUsdc: new Decimal(String(t.perCreatorCapUsdc)),
        },
      },
    };
  } else if (type === 'snapshot_taken') {
    const s = e.snapshot as Record<string, unknown>;
    event = {
      type,
      snapshot: { ...(s as unknown as Snapshot), views: BigInt(String(s.views)) },
    };
  } else if (type === 'payout_settled') {
    const p = e.payout as Record<string, unknown>;
    event = {
      type,
      payout: {
        ...(p as unknown as Payout),
        viewsPaidTo: BigInt(String(p.viewsPaidTo)),
        amountUsdc: new Decimal(String(p.amountUsdc)),
      },
    };
  } else if (type === 'creator_upserted') {
    event = { type, creator: e.creator as Creator };
  } else if (type === 'verdict_recorded') {
    event = { type, verdict: e.verdict as Verdict };
  } else {
    throw new RangeError(`unknown event type: ${type}`);
  }

  return {
    version: EVENT_VERSION,
    eventId: String(parsed.eventId),
    at: String(parsed.at),
    event,
  };
}

/* ─────────────────────────── the derived chain ─────────────────────────── */

/** Key order is byte order, so the sort is stable across every reader. */
function canonicalOrder(a: EventEnvelope, b: EventEnvelope): number {
  return keyFor(a) < keyFor(b) ? -1 : keyFor(a) > keyFor(b) ? 1 : 0;
}

export interface ChainLink {
  readonly eventId: string;
  readonly at: string;
  readonly hash: string;
  readonly previous: string;
}

const GENESIS = '0'.repeat(64);

/**
 * Hash the log forward.
 *
 * A pure function of the events, so two independent readers given the same log
 * produce the same root — which is the property that makes this verifiable by
 * someone who does not trust us.
 */
export function chainOver(events: readonly EventEnvelope[]): {
  links: ChainLink[];
  root: string;
} {
  const ordered = [...events].sort(canonicalOrder);
  const links: ChainLink[] = [];
  let previous = GENESIS;

  for (const envelope of ordered) {
    const hash = createHash('sha256')
      .update(previous)
      .update(encodeEvent(envelope))
      .digest('hex');
    links.push({ eventId: envelope.eventId, at: envelope.at, hash, previous });
    previous = hash;
  }
  return { links, root: previous };
}

/**
 * Whether a log still hashes to a root.
 *
 * Recomputes rather than trusting stored links — the point of deriving the
 * chain is that verification needs nothing but the events themselves.
 */
export function verifyChain(
  events: readonly EventEnvelope[],
  expectedRoot: string,
): { ok: boolean; root: string } {
  const { root } = chainOver(events);
  return { ok: root === expectedRoot, root };
}
