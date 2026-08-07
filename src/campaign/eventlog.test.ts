/**
 * The append-only log, and the concurrency failure it exists to remove.
 *
 * The test that matters is `two concurrent passes both survive`. Under the
 * previous whole-blob design that case lost a payout from the record while the
 * money had actually moved.
 */

import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { Decimal } from '../decimal';
import { chainOver, decodeEvent, encodeEvent, eventIdFor, keyFor } from './events';
import type { CampaignEvent, EventEnvelope } from './events';
import { EVENT_PREFIX, EventLog } from './eventlog';
import { MemoryBlobStore } from './persistence';
import { CampaignStore } from './store';
import { termsFor } from './terms';
import type { Campaign, Payout } from './types';

const CAMPAIGN: Campaign = {
  campaignId: 'camp-1',
  brief: 'Clip the podcast.',
  poolUsdc: new Decimal('100'),
  cpmUsdc: new Decimal('1'),
  rateBand: { minUsdc: new Decimal('0.5'), maxUsdc: new Decimal('2') },
  perCreatorCapUsdc: new Decimal('10'),
  dwellMs: 86_400_000,
  settlementWindowMs: 14 * 86_400_000,
  platforms: ['youtube'],
  chain: 'base-sepolia',
  status: 'active',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
};

const payout = (id: string, views: bigint, amount: string): Payout => ({
  payoutId: id,
  submissionId: 'sub-1',
  campaignId: 'camp-1',
  creatorId: 'cre-1',
  viewsPaidTo: views,
  amountUsdc: new Decimal(amount),
  at: '2026-08-05T12:00:00.000Z',
});

const seed = (log: EventLog) =>
  Promise.all([
    log.append({ type: 'campaign_upserted', campaign: CAMPAIGN }, new Date('2026-08-01T00:00:00Z')),
    log.append(
      { type: 'creator_upserted', creator: { creatorId: 'cre-1', payoutAddress: '0xa', handles: {} } },
      new Date('2026-08-01T00:01:00Z'),
    ),
    log.append(
      {
        type: 'submission_accepted',
        submission: {
          submissionId: 'sub-1',
          campaignId: 'camp-1',
          creatorId: 'cre-1',
          platform: 'youtube',
          postId: 'p',
          url: 'https://youtube.com/shorts/p',
          submittedAt: '2026-08-02T00:00:00.000Z',
          acceptedTerms: termsFor(CAMPAIGN, new Date('2026-08-02T00:00:00Z')),
        },
      },
      new Date('2026-08-02T00:00:00Z'),
    ),
  ]);

describe('the failure this replaces', () => {
  test('two concurrent passes both survive — neither clobbers the other', async () => {
    // The whole-blob design lost one of these: both loaded the same state,
    // both saved, and the second overwrote the first. The money had moved.
    const blobs = new MemoryBlobStore();
    const log = new EventLog(blobs);
    await seed(log);

    await Promise.all([
      log.append({ type: 'payout_settled', payout: payout('po-a', 1_000n, '1') }),
      log.append({ type: 'payout_settled', payout: payout('po-b', 2_000n, '2') }),
    ]);

    const store = new CampaignStore();
    await log.hydrate(store);
    expect(store.spentOnCampaign('camp-1').toString()).toBe('3');
    expect(store.payoutsFor('camp-1')).toHaveLength(2);
  });

  test('the same payout written twice is recorded once', async () => {
    const blobs = new MemoryBlobStore();
    const log = new EventLog(blobs);
    await seed(log);

    const same = payout('po-1', 1_000n, '1');
    expect(await log.append({ type: 'payout_settled', payout: same })).toBe(true);
    expect(await log.append({ type: 'payout_settled', payout: same })).toBe(false);

    const store = new CampaignStore();
    await log.hydrate(store);
    expect(store.payoutsFor('camp-1')).toHaveLength(1);
    expect(store.spentOnCampaign('camp-1').toString()).toBe('1');
  });

  test('a crash after settling, then a retry, does not pay twice', async () => {
    // The retry presents the same deterministic id and is refused by the
    // store's own precondition rather than by us remembering to check.
    const blobs = new MemoryBlobStore();
    const log = new EventLog(blobs);
    await seed(log);
    const settled = payout('pay-sub-1-1000', 1_000n, '1');

    await log.append({ type: 'payout_settled', payout: settled });
    await log.append({ type: 'payout_settled', payout: settled }); // retry after crash

    const store = new CampaignStore();
    await log.hydrate(store);
    expect(store.viewsPaidTo('sub-1')).toBe(1_000n);
    expect(store.spentOnCampaign('camp-1').toString()).toBe('1');
  });
});

describe('replaying', () => {
  test('a store rebuilt from the log matches what was written', async () => {
    const log = new EventLog(new MemoryBlobStore());
    await seed(log);
    await log.append({ type: 'snapshot_taken', snapshot: {
      submissionId: 'sub-1', views: 12_345n, fetchedAt: '2026-08-04T00:00:00.000Z', source: 'youtube',
    } });
    await log.append({ type: 'payout_settled', payout: payout('po-1', 12_345n, '12.345') });

    const store = new CampaignStore();
    const n = await log.hydrate(store);
    expect(n).toBe(5);
    expect(store.campaign('camp-1')?.poolUsdc.toString()).toBe('100');
    expect(store.snapshots('sub-1')[0]?.views).toBe(12_345n);
    expect(store.viewsPaidTo('sub-1')).toBe(12_345n);
    expect(store.remainingPool('camp-1').toString()).toBe('87.655');
    // Frozen terms survive a replay, or the brand gets its discretion back.
    expect(store.submission('sub-1')?.acceptedTerms.cpmUsdc.toString()).toBe('1');
  });

  test('hydrating twice does not double-apply', async () => {
    const log = new EventLog(new MemoryBlobStore());
    await seed(log);
    await log.append({ type: 'payout_settled', payout: payout('po-1', 1_000n, '1') });

    const store = new CampaignStore();
    await log.hydrate(store);
    await log.hydrate(store);
    expect(store.spentOnCampaign('camp-1').toString()).toBe('1');
  });

  test('one unreadable event aborts the replay rather than skipping it', async () => {
    // Skipping would produce a state missing a payout, and the next pass would
    // pay those views again.
    const blobs = new MemoryBlobStore();
    const log = new EventLog(blobs);
    await seed(log);
    await blobs.put(`${EVENT_PREFIX}2026-08-09T00-00-00-000Z__corrupt.json`, '{not json');

    await expect(log.hydrate(new CampaignStore())).rejects.toThrow(/could not be read/);
  });

  test('an unknown event version is refused, not guessed at', () => {
    expect(() => decodeEvent(JSON.stringify({ version: 99, eventId: 'x', at: 'y', event: {} })))
      .toThrow(/refusing/);
  });
});

describe('the derived chain', () => {
  test('order is canonical, so two readers agree regardless of write order', async () => {
    const forward = new EventLog(new MemoryBlobStore());
    const backward = new EventLog(new MemoryBlobStore());
    const a: CampaignEvent = { type: 'payout_settled', payout: payout('po-a', 1n, '1') };
    const b: CampaignEvent = { type: 'payout_settled', payout: payout('po-b', 2n, '2') };

    await forward.append(a, new Date('2026-08-05T00:00:00Z'));
    await forward.append(b, new Date('2026-08-06T00:00:00Z'));
    await backward.append(b, new Date('2026-08-06T00:00:00Z'));
    await backward.append(a, new Date('2026-08-05T00:00:00Z'));

    // This is the property a hash chain cannot offer under concurrent append:
    // the root does not depend on who wrote first.
    expect((await forward.chain()).root).toBe((await backward.chain()).root);
  });

  test('altering one event changes every hash after it', async () => {
    const blobs = new MemoryBlobStore();
    const log = new EventLog(blobs);
    await seed(log);
    await log.append({ type: 'payout_settled', payout: payout('po-1', 1_000n, '1') });
    await log.append({ type: 'payout_settled', payout: payout('po-2', 2_000n, '2') });
    const before = await log.chain();

    // Tamper: rewrite the first payout to a larger amount.
    const keys = await blobs.list(EVENT_PREFIX);
    const target = keys.find((k) => k.includes('po-1'))!;
    const raw = JSON.parse((await blobs.get(target))!) as Record<string, any>;
    raw.event.payout.amountUsdc = '99';
    await blobs.put(target, JSON.stringify(raw, null, 2));

    const after = await log.chain();
    expect(after.root).not.toBe(before.root);
  });

  test('an empty log has a stable root', async () => {
    expect(chainOver([]).root).toBe('0'.repeat(64));
  });
});

describe('keys', () => {
  test('a payout key carries the settlement idempotency id', () => {
    const e: CampaignEvent = { type: 'payout_settled', payout: payout('pay-sub-1-2000', 2_000n, '2') };
    expect(eventIdFor(e, '2026-08-05T12:00:00.000Z')).toBe('pay-sub-1-2000');
  });

  test('the timestamp leads, so key order is time order', () => {
    const mk = (at: string): EventEnvelope => ({
      version: 1, eventId: 'z', at,
      event: { type: 'payout_settled', payout: payout('z', 1n, '1') },
    });
    expect(keyFor(mk('2026-08-01T00:00:00.000Z')) < keyFor(mk('2026-08-02T00:00:00.000Z'))).toBe(true);
  });

  test('no identifying data reaches the key', () => {
    // Object keys land in access logs and bucket listings. An email or handle
    // there is somewhere a person's address does not need to be.
    const e: CampaignEvent = {
      type: 'creator_upserted',
      creator: { creatorId: 'cre-1', payoutAddress: '0xabc', handles: { youtube: '@someone' } },
    };
    const key = keyFor({ version: 1, eventId: eventIdFor(e, '2026-08-05T12:00:00.000Z'), at: '2026-08-05T12:00:00.000Z', event: e });
    expect(key).not.toContain('@someone');
    expect(key).not.toContain('0xabc');
  });
});

describe('money survives the round trip exactly', () => {
  test('amounts and view counts encode and decode without loss', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        (micro, views) => {
          const p = payout('po', views, Decimal.fromMicro(micro).toString());
          const env: EventEnvelope = {
            version: 1, eventId: 'po', at: '2026-08-05T12:00:00.000Z',
            event: { type: 'payout_settled', payout: p },
          };
          const back = decodeEvent(encodeEvent(env));
          const out = (back.event as { payout: Payout }).payout;
          expect(out.amountUsdc.micro).toBe(micro);
          expect(out.viewsPaidTo).toBe(views);
        },
      ),
      { numRuns: 300 },
    );
  });
});
