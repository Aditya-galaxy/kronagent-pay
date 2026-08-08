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

/* ───────────────── the wallet is chosen by the network ───────────────── */

const TESTNET_W = '0xf461c5bb7e314670ae5c5eeb9929b15728ab2b6c';
const MAINNET_W = '0x0003a59858f44451be2a5b486ee612b4139700f0';

/** Reach into the built executor — this is exactly what must not drift. */
const walletOf = (r: CampaignRuntime) =>
  (r as unknown as { executor: { options?: { fromAddress?: string } } }).executor?.options
    ?.fromAddress;
const isDry = (r: CampaignRuntime) =>
  (r as unknown as { executor: { dryRun?: boolean } }).executor?.dryRun;

describe('a network mismatch cannot be configured', () => {
  test('arming mainnet without a mainnet wallet refuses to start', () => {
    // The dangerous configuration, and the one a single flag made expressible:
    // mainnet armed while still pointed at the testnet wallet. It has to fail
    // here, not at the first payout — the first payout is the one with money.
    expect(
      () => new CampaignRuntime({
        blobs: new MemoryBlobStore(),
        env: { ALLOW_MAINNET: 'true', CAMPAIGN_WALLET: TESTNET_W },
      }),
    ).toThrow(/MAINNET_CAMPAIGN_WALLET/);
  });

  test('unarmed uses the testnet wallet even when a mainnet one is present', () => {
    const r = new CampaignRuntime({
      blobs: new MemoryBlobStore(),
      env: { CAMPAIGN_WALLET: TESTNET_W, MAINNET_CAMPAIGN_WALLET: MAINNET_W },
    });
    expect(walletOf(r)).toBe(TESTNET_W);
  });

  test('armed uses the mainnet wallet, never the testnet one', () => {
    const r = new CampaignRuntime({
      blobs: new MemoryBlobStore(),
      env: { ALLOW_MAINNET: 'true', CAMPAIGN_WALLET: TESTNET_W, MAINNET_CAMPAIGN_WALLET: MAINNET_W },
    });
    expect(walletOf(r)).toBe(MAINNET_W);
  });
});

describe('broadcasting is a separate decision from the network', () => {
  test('armed for mainnet still only estimates until BROADCAST is set', () => {
    // The two flags were one flag. Conflated, the only way to broadcast a
    // testnet payout was to also unlock mainnet.
    const r = new CampaignRuntime({
      blobs: new MemoryBlobStore(),
      env: { ALLOW_MAINNET: 'true', MAINNET_CAMPAIGN_WALLET: MAINNET_W },
    });
    expect(isDry(r)).toBe(true);
  });

  test('testnet can broadcast for real without unlocking mainnet', () => {
    const r = new CampaignRuntime({
      blobs: new MemoryBlobStore(),
      env: { BROADCAST: 'true', CAMPAIGN_WALLET: TESTNET_W },
    });
    expect(isDry(r)).toBe(false);
    expect(walletOf(r)).toBe(TESTNET_W);
  });

  test('no wallet at all settles nothing rather than guessing', () => {
    const r = new CampaignRuntime({ blobs: new MemoryBlobStore(), env: {} });
    expect(walletOf(r)).toBeUndefined();
  });
});

describe('a tick never runs twice at once in one process', () => {
  test('overlapping callers share the in-flight pass', async () => {
    // Cloud Scheduler retries. Without this, a retry arriving mid-pass reads
    // the same viewsPaidTo and calls the executor for payouts already sent.
    let started = 0;
    const runtime = new CampaignRuntime({
      blobs: new MemoryBlobStore(),
      env: {},
      executor: {
        async send() {
          started += 1;
          await new Promise((r) => setTimeout(r, 20));
          return { intentId: 'i', executed: true, dryRun: true, detail: 'ok', settledAt: NOW.toISOString() };
        },
      },
    });

    const [a, b] = await Promise.all([runtime.tick(NOW), runtime.tick(NOW)]);
    expect(a).toBe(b); // the same result object — one pass, not two
    expect(started).toBe(0); // nothing to settle here; the point is it ran once
  });

  test('a later tick still runs once the first has finished', async () => {
    const runtime = new CampaignRuntime({ blobs: new MemoryBlobStore(), env: {} });
    const first = await runtime.tick(NOW);
    const second = await runtime.tick(NOW);
    expect(second).not.toBe(first); // not a stuck promise
  });
});
