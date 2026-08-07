/**
 * The append-only campaign log.
 *
 * One object per event, keyed so that key order is time order, written with a
 * create-only precondition. Two concurrent passes touch different keys and
 * neither clobbers the other; two passes producing the *same* fact produce the
 * same key and the second write is refused rather than duplicated.
 *
 * State is rebuilt by replaying the log. The hash chain is computed over it on
 * read — see `events.ts` for why nothing writes chain links.
 */

import {
  EVENT_VERSION,
  chainOver,
  decodeEvent,
  encodeEvent,
  eventIdFor,
  keyFor,
  type CampaignEvent,
  type ChainLink,
  type EventEnvelope,
} from './events';
import type { BlobStore } from './persistence';
import type { CampaignStore } from './store';

export const EVENT_PREFIX = 'events/';

export class EventLog {
  constructor(private readonly blobs: BlobStore) {}

  /**
   * Record a fact.
   *
   * Returns false when the event was already recorded — not an error. A pass
   * that crashed after settling and retries lands here with the same
   * deterministic id, and "already known" is the correct outcome.
   */
  async append(event: CampaignEvent, at: Date = new Date()): Promise<boolean> {
    const iso = at.toISOString();
    const envelope: EventEnvelope = {
      version: EVENT_VERSION,
      eventId: eventIdFor(event, iso),
      at: iso,
      event,
    };
    return this.blobs.putIfAbsent(keyFor(envelope), encodeEvent(envelope));
  }

  /**
   * Every event, in canonical order.
   *
   * A single unreadable object aborts the replay rather than being skipped.
   * Skipping would silently produce a state missing a payout, and the next
   * pass would pay those views again — the exact failure this design exists to
   * remove.
   */
  async replay(): Promise<EventEnvelope[]> {
    const keys = await this.blobs.list(EVENT_PREFIX);
    const envelopes: EventEnvelope[] = [];
    for (const key of keys) {
      const raw = await this.blobs.get(key);
      if (raw === undefined) continue; // listed then deleted; nothing to replay
      try {
        envelopes.push(decodeEvent(raw));
      } catch (error) {
        throw new Error(`event ${key} could not be read: ${(error as Error).message}`);
      }
    }
    return envelopes;
  }

  /** Rebuild a store from the log. Called on boot, never mid-decision. */
  async hydrate(store: CampaignStore): Promise<number> {
    const envelopes = await this.replay();
    store.hydrate({
      campaigns: [],
      creators: [],
      submissions: [],
      verdicts: [],
      snapshots: [],
      payouts: [],
    });
    for (const { event } of envelopes) apply(store, event);
    return envelopes.length;
  }

  /** The derived chain, recomputed from the events themselves. */
  async chain(): Promise<{ links: ChainLink[]; root: string }> {
    return chainOver(await this.replay());
  }
}

/**
 * Fold one event into a store.
 *
 * Deliberately a total switch on the union: adding an event type without
 * handling it here fails to compile, rather than replaying to a state that is
 * quietly missing whatever the new event carried.
 */
export function apply(store: CampaignStore, event: CampaignEvent): void {
  switch (event.type) {
    case 'campaign_upserted':
      store.putCampaign(event.campaign);
      return;
    case 'creator_upserted':
      store.putCreator(event.creator);
      return;
    case 'submission_accepted':
      store.putSubmission(event.submission);
      return;
    case 'verdict_recorded':
      store.addVerdict(event.verdict);
      return;
    case 'snapshot_taken':
      store.addSnapshot(event.snapshot);
      return;
    case 'payout_settled':
      store.recordPayout(event.payout);
      return;
  }
  const exhaustive: never = event;
  throw new Error(`unhandled event: ${JSON.stringify(exhaustive)}`);
}
