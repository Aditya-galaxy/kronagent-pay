/**
 * The service wrapper, and mostly the thing guarding it.
 *
 * The service is public by competition requirement. An unauthenticated
 * endpoint that disburses USDC would be the largest hole in the system, so the
 * tests here are mostly about who is allowed to start a pass.
 */

import { describe, expect, test } from 'bun:test';

import { Decimal } from '../decimal';
import { issueMandate } from '../mandates';
import { MemoryBlobStore } from './persistence';
import { CampaignRuntime, chooseBlobStore } from './runtime';
import { termsFor } from './terms';
import { DryRunExecutor } from './tick';
import type { Campaign } from './types';

const NOW = new Date('2026-08-05T12:00:00.000Z');

const campaign: Campaign = {
  campaignId: 'camp-1',
  brief: 'Clip the podcast.',
  poolUsdc: new Decimal('100'),
  cpmUsdc: new Decimal('1'),
  rateBand: { minUsdc: new Decimal('0.5'), maxUsdc: new Decimal('2') },
  perCreatorCapUsdc: new Decimal('50'),
  dwellMs: 86_400_000,
  settlementWindowMs: 14 * 86_400_000,
  platforms: ['youtube'],
  chain: 'base-sepolia',
  status: 'active',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
};

async function runtime(env: Record<string, string | undefined> = {}) {
  const rt = new CampaignRuntime({
    blobs: new MemoryBlobStore(),
    executor: new DryRunExecutor(),
    env: { TICK_SECRET: 'correct-horse', ...env },
  });

  // Through the log, not into the store. `ready()` replays the log over the
  // store, so anything written directly is erased on the next route call —
  // which is the point: the log is the source of truth.
  await rt.record({ type: 'campaign_upserted', campaign });
  await rt.record({
    type: 'creator_upserted',
    creator: { creatorId: 'cre-1', payoutAddress: '0xabc', handles: {} },
  });
  await rt.record({
    type: 'submission_accepted',
    submission: {
      submissionId: 'sub-1',
      campaignId: 'camp-1',
      creatorId: 'cre-1',
      platform: 'youtube',
      postId: 'p',
      url: 'https://youtube.com/shorts/p',
      submittedAt: '2026-08-02T00:00:00.000Z',
      acceptedTerms: termsFor(campaign, new Date('2026-08-02T00:00:00.000Z')),
    },
  });
  await rt.record({
    type: 'verdict_recorded',
    verdict: {
      verdictId: 'v-1', submissionId: 'sub-1', pass: true, reasons: ['ok'],
      confidence: 1, model: 'test', at: '2026-08-03T00:00:00.000Z',
    },
  });
  await rt.record({
    type: 'snapshot_taken',
    snapshot: {
      submissionId: 'sub-1', views: 2_000n,
      fetchedAt: '2026-08-04T00:00:00.000Z', source: 'youtube',
    },
  });
  rt.mandates.put(
    issueMandate({
      counterparty: '0xabc', maxPerPaymentUsdc: '50',
      issuedBy: 'operator', reason: 'campaign', now: NOW,
    }),
  );
  return rt;
}

const tickRequest = (secret?: string) =>
  new Request('http://x/api/tick', {
    method: 'POST',
    headers: secret === undefined ? {} : { 'x-tick-secret': secret },
  });

describe('who may start a payout pass', () => {
  test('the right secret runs a pass', async () => {
    const response = await (await runtime()).handleTick(tickRequest('correct-horse'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { paid: number; totalPaidUsdc: string };
    expect(body.paid).toBe(1);
    expect(body.totalPaidUsdc).toBe('2');
  });

  test('a wrong secret is refused', async () => {
    const response = await (await runtime()).handleTick(tickRequest('wrong'));
    expect(response.status).toBe(401);
  });

  test('no secret at all is refused', async () => {
    const response = await (await runtime()).handleTick(tickRequest());
    expect(response.status).toBe(401);
  });

  test('an unconfigured deployment refuses to tick rather than running open', async () => {
    // The failure that would matter: a public endpoint that disburses USDC to
    // anyone who finds it.
    const rt = await runtime({ TICK_SECRET: undefined });
    const response = await rt.handleTick(tickRequest('anything'));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('refusing to run a payout pass');
  });

  test('a refused tick moves no money', async () => {
    const rt = await runtime();
    await rt.handleTick(tickRequest('wrong'));
    expect(rt.store.spentOnCampaign('camp-1').toString()).toBe('0');
  });
});

describe('what a creator can read before doing the work', () => {
  test('the remaining pool is published, and drops after a pass', async () => {
    const rt = await runtime();
    const before = await rt.publicView();
    expect(before.campaigns[0]?.remainingUsdc).toBe('100');

    await rt.handleTick(tickRequest('correct-horse'));
    const after = await rt.publicView();
    expect(after.campaigns[0]?.remainingUsdc).toBe('98');
    expect(after.lastTick?.paid).toBe(1);
  });

  test('ephemeral storage is reported rather than hidden', async () => {
    // On Cloud Run this means the dwell window can never be satisfied. Saying
    // so beats a campaign that silently holds everything forever.
    const view = await (await runtime()).publicView();
    expect(view.ephemeral).toBe(true);
  });
});

describe('choosing where state lives', () => {
  test('a bucket wins, then a directory, then memory', () => {
    expect(chooseBlobStore({ GCS_BUCKET: 'b', STATE_DIR: '/tmp' }).constructor.name)
      .toBe('GcsBlobStore');
    expect(chooseBlobStore({ STATE_DIR: '/tmp' }).constructor.name).toBe('FileBlobStore');
    expect(chooseBlobStore({}).constructor.name).toBe('MemoryBlobStore');
  });
});
