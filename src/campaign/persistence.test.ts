/**
 * Round-tripping campaign state.
 *
 * The property test is the important one. A precision bug in serialisation
 * would not be caught by any arithmetic test — the maths would be right and
 * the number would change on the way to disk — so money and view counts are
 * fuzzed through encode/decode and compared exactly.
 */

import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { Decimal } from '../decimal';
import { CampaignStore } from './store';
import { termsFor } from './terms';
import {
  GcsBlobStore,
  MemoryBlobStore,
  STATE_VERSION,
  decodeState,
  encodeState,
  loadInto,
  saveFrom,
} from './persistence';
import type { Campaign } from './types';

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
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
  ...over,
});

function populated(): CampaignStore {
  const store = new CampaignStore();
  store.putCampaign(campaign());
  store.putCreator({ creatorId: 'cre-1', payoutAddress: '0xabc', handles: { youtube: '@c' } });
  store.putSubmission({
    submissionId: 'sub-1',
    campaignId: 'camp-1',
    creatorId: 'cre-1',
    platform: 'youtube',
    postId: 'yt-1',
    url: 'https://youtube.com/shorts/1',
    submittedAt: '2026-08-02T00:00:00.000Z',
    acceptedTerms: termsFor(campaign(), new Date('2026-08-02T00:00:00.000Z')),
  });
  store.addVerdict({
    verdictId: 'v-1',
    submissionId: 'sub-1',
    pass: true,
    reasons: ['shows the product'],
    confidence: 0.91,
    model: 'gemini',
    at: '2026-08-03T00:00:00.000Z',
  });
  store.addSnapshot({
    submissionId: 'sub-1',
    views: 12_345n,
    fetchedAt: '2026-08-03T00:00:00.000Z',
    source: 'youtube',
  });
  store.recordPayout({
    payoutId: 'p-1',
    submissionId: 'sub-1',
    campaignId: 'camp-1',
    creatorId: 'cre-1',
    viewsPaidTo: 12_345n,
    amountUsdc: new Decimal('12.345'),
    at: '2026-08-04T00:00:00.000Z',
  });
  return store;
}

describe('surviving a restart', () => {
  test('a store round-trips through encode and decode intact', () => {
    const before = populated();
    const after = new CampaignStore();
    after.hydrate(decodeState(encodeState(before.exportState())));

    expect(after.campaign('camp-1')?.poolUsdc.toString()).toBe('100');
    expect(after.viewsPaidTo('sub-1')).toBe(12_345n);
    expect(after.spentOnCampaign('camp-1').toString()).toBe('12.345');
    expect(after.snapshots('sub-1')[0]?.views).toBe(12_345n);
    expect(after.latestVerdict('sub-1')?.pass).toBe(true);
    expect(after.remainingPool('camp-1').toString()).toBe('87.655');
  });

  test('the dwell window survives the process that recorded it', () => {
    // The reason this file exists: yesterday's count has to outlive the
    // instance that fetched it, or nothing is ever payable.
    const before = new CampaignStore();
    before.putCampaign(campaign());
    before.addSnapshot({
      submissionId: 'sub-1',
      views: 900n,
      fetchedAt: '2026-08-01T00:00:00.000Z',
      source: 'youtube',
    });
    const after = new CampaignStore();
    after.hydrate(decodeState(encodeState(before.exportState())));
    expect(after.snapshots('sub-1')).toHaveLength(1);
    expect(after.snapshots('sub-1')[0]?.fetchedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  test('save and load through a blob store', async () => {
    const blobs = new MemoryBlobStore();
    await saveFrom(populated(), blobs);

    const restored = new CampaignStore();
    expect(await loadInto(restored, blobs)).toBe(true);
    expect(restored.spentOnCampaign('camp-1').toString()).toBe('12.345');
  });

  test('a first boot with no saved state is not an error', async () => {
    const store = new CampaignStore();
    expect(await loadInto(store, new MemoryBlobStore())).toBe(false);
  });
});

describe('refusing what it cannot read', () => {
  test('a future state version is refused rather than partly applied', () => {
    // Half-loaded history would read as "nobody has ever been paid", and the
    // next tick would pay everyone again.
    const raw = JSON.stringify({ version: STATE_VERSION + 1, campaigns: [] });
    expect(() => decodeState(raw)).toThrow(/refusing to load/);
  });

  test('missing collections decode as empty rather than undefined', () => {
    const state = decodeState(JSON.stringify({ version: STATE_VERSION }));
    expect(state.campaigns).toEqual([]);
    expect(state.payouts).toEqual([]);
  });
});

describe('money and counts never become JSON numbers', () => {
  test('amounts and view counts survive a round trip exactly', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        (micro, views) => {
          const amount = Decimal.fromMicro(micro);
          const store = new CampaignStore();
          store.putCampaign(campaign({ poolUsdc: amount, cpmUsdc: amount }));
          store.recordPayout({
            payoutId: 'p',
            submissionId: 's',
            campaignId: 'camp-1',
            creatorId: 'c',
            viewsPaidTo: views,
            amountUsdc: amount,
            at: '2026-08-04T00:00:00.000Z',
          });

          const after = new CampaignStore();
          after.hydrate(decodeState(encodeState(store.exportState())));

          expect(after.campaign('camp-1')!.poolUsdc.micro).toBe(micro);
          expect(after.viewsPaidTo('s')).toBe(views);
          expect(after.spentOnCampaign('camp-1').micro).toBe(micro);
        },
      ),
      { numRuns: 400 },
    );
  });

  test('a view count beyond Number.MAX_SAFE_INTEGER is not silently rounded', () => {
    const huge = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
    const store = new CampaignStore();
    store.addSnapshot({
      submissionId: 's',
      views: huge,
      fetchedAt: '2026-08-01T00:00:00.000Z',
      source: 'youtube',
    });
    const after = new CampaignStore();
    after.hydrate(decodeState(encodeState(store.exportState())));
    expect(after.snapshots('s')[0]?.views).toBe(huge);
  });
});

describe('Cloud Storage adapter', () => {
  const tokenResponse = {
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'tok', expires_in: 3600 }),
  };

  test('a missing object reads as a first boot, not a failure', async () => {
    const gcs = new GcsBlobStore('bucket', (async (url: string) =>
      String(url).includes('metadata')
        ? tokenResponse
        : { ok: false, status: 404 }) as unknown as typeof fetch);
    expect(await gcs.get('campaign-state.json')).toBeUndefined();
  });

  test('a real read error is not mistaken for absent state', async () => {
    // Treating a 500 as "no state" would restart the campaign from zero and
    // pay everyone a second time.
    const gcs = new GcsBlobStore('bucket', (async (url: string) =>
      String(url).includes('metadata')
        ? tokenResponse
        : { ok: false, status: 500 }) as unknown as typeof fetch);
    await expect(gcs.get('campaign-state.json')).rejects.toThrow(/GCS read failed: 500/);
  });

  test('the access token is fetched once and reused', async () => {
    let tokenCalls = 0;
    const gcs = new GcsBlobStore('bucket', (async (url: string) => {
      if (String(url).includes('metadata')) {
        tokenCalls += 1;
        return tokenResponse;
      }
      return { ok: true, status: 200, text: async () => '{}' };
    }) as unknown as typeof fetch);

    await gcs.get('a');
    await gcs.get('b');
    await gcs.put('c', '{}');
    expect(tokenCalls).toBe(1);
  });
});
