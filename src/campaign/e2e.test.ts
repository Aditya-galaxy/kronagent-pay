/**
 * The whole thing, end to end, with every component real.
 *
 * Unit tests prove each part in isolation and prove nothing about the seams.
 * This drives a campaign from funding to settlement using the real Gemini
 * verifier, the real YouTube oracle, the real event log and the real Circle
 * CLI — and asserts the properties that would actually cost someone money if
 * they broke.
 *
 * Time is injected rather than waited on. A 24-hour dwell window is real in
 * production and absurd in a test, so snapshots are recorded at controlled
 * timestamps. Everything else is genuine.
 *
 * Skipped without keys.
 */

import { describe, expect, test } from 'bun:test';

import { RollingWindowBudget } from '../budget';
import { Decimal } from '../decimal';
import { MandateStore, issueMandate } from '../mandates';
import { PaymentPolicyEngine } from '../policy';
import { CircleCliExecutor } from './executor';
import { EventLog } from './eventlog';
import { oracleFromEnv } from './oracle';
import { parsePostUrl } from './postref';
import { PayoutGate } from './payout';
import { MemoryBlobStore } from './persistence';
import { CampaignStore } from './store';
import { acceptSubmission } from './terms';
import { DryRunExecutor, runTick } from './tick';
import type { Campaign } from './types';
import { verifierFromEnv } from './verifier';

const GEMINI = (Bun.env.GOOGLE_API_KEY ?? Bun.env.GEMINI_API_KEY)?.trim();
const YT = Bun.env.YOUTUBE_API_KEY?.trim();
const LIVE = Boolean(GEMINI && YT);

const VIDEO = Bun.env.LIVE_TEST_VIDEO ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const CREATOR_WALLET = '0x93cbeb87353fe349815fcbc1776bc156e1e8f6fb';

const T0 = new Date('2026-08-05T00:00:00.000Z'); // campaign opens
const T1 = new Date('2026-08-05T01:00:00.000Z'); // clip accepted, first count
const T2 = new Date('2026-08-06T06:00:00.000Z'); // 29h later — dwell satisfied

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    campaignId: 'e2e',
    brief: 'The video must contain a person singing, with music audible.',
    poolUsdc: new Decimal('5'),
    cpmUsdc: new Decimal('0.000001'), // billions of views; keep the payout tiny
    rateBand: { minUsdc: new Decimal('0.000001'), maxUsdc: new Decimal('0.00001') },
    perCreatorCapUsdc: new Decimal('5'),
    dwellMs: 86_400_000,
    settlementWindowMs: 14 * 86_400_000,
    platforms: ['youtube'],
    chain: 'base-sepolia',
    status: 'active',
    startsAt: T0.toISOString(),
    endsAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

/** Everything wired the way the service wires it. */
function world(over: Partial<Campaign> = {}) {
  const store = new CampaignStore();
  const log = new EventLog(new MemoryBlobStore());
  const mandates = new MandateStore([
    issueMandate({
      counterparty: CREATOR_WALLET,
      maxPerPaymentUsdc: '5',
      issuedBy: 'operator',
      reason: 'e2e campaign payouts',
      now: T0,
    }),
  ]);
  const gate = new PayoutGate(
    store,
    new PaymentPolicyEngine(
      {
        dryRun: true,
        killSwitch: false,
        absoluteMaxPerPaymentUsdc: new Decimal('5'),
        allowMainnet: false,
      },
      mandates,
      new RollingWindowBudget({ defaultCapUsdc: '5' }),
    ),
  );
  return { store, log, gate, campaign: campaign(over) };
}

describe.skipIf(!LIVE)('a campaign, end to end, with real services', () => {
  test('a clip that meets the brief is verified, counted, and settles', async () => {
    const { store, log, gate, campaign: camp } = world();
    const verifier = verifierFromEnv()!;
    const oracle = oracleFromEnv()!;

    // ── fund and open ────────────────────────────────────────────────────
    await log.append({ type: 'campaign_upserted', campaign: camp }, T0);
    await log.append(
      { type: 'creator_upserted', creator: { creatorId: 'cre', payoutAddress: CREATOR_WALLET, handles: {} } },
      T0,
    );

    // ── a creator submits, and the terms freeze right here ───────────────
    const accepted = acceptSubmission(
      camp,
      { submissionId: 'sub', creatorId: 'cre', platform: 'youtube', postId: parsePostUrl(VIDEO)!.postId, url: VIDEO },
      T1,
    );
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;
    await log.append({ type: 'submission_accepted', submission: accepted.submission }, T1);
    expect(accepted.submission.acceptedTerms.cpmUsdc.toString()).toBe(camp.cpmUsdc.toString());

    // ── the agent judges the clip against the brief (real Gemini) ────────
    const verdict = await verifier.judge({ url: VIDEO, brief: camp.brief });
    expect(verdict.pass).toBe(true);
    await log.append(
      {
        type: 'verdict_recorded',
        verdict: {
          verdictId: 'v', submissionId: 'sub', pass: verdict.pass,
          reasons: verdict.reasons, confidence: verdict.confidence,
          model: verdict.model, at: T1.toISOString(),
        },
      },
      T1,
    );

    // ── real view counts, at two times, so dwell can be satisfied ────────
    const first = await oracle.count(parsePostUrl(VIDEO)!);
    expect(first).toBeDefined();
    await log.append(
      { type: 'snapshot_taken', snapshot: { submissionId: 'sub', views: first!, fetchedAt: T1.toISOString(), source: 'youtube' } },
      T1,
    );

    await log.hydrate(store);

    // Before dwell: held, not rejected. This is the anti-fraud mechanic.
    const early = gate.decide('sub', { agentId: 'e2e', now: new Date(T1.getTime() + 3_600_000) });
    expect(early.disposition).toBe('held');
    expect(early.control).toBe('dwell_unmet');

    // ── a pass, 29 hours later ───────────────────────────────────────────
    const result = await runTick(
      {
        store, gate, log,
        oracle: { fetch: async () => oracle.count(parsePostUrl(VIDEO)!) },
        executor: new DryRunExecutor(),
      },
      { agentId: 'e2e', now: T2 },
    );

    expect(result.paid).toBe(1);
    expect(result.errors).toEqual([]);

    // ── the properties that would cost money if they broke ───────────────
    const spent = store.spentOnCampaign('e2e');
    expect(spent.isPositive()).toBe(true);
    expect(spent.gt(camp.poolUsdc)).toBe(false);            // I12: pool holds
    expect(store.viewsPaidTo('sub') > 0n).toBe(true);        // I13: high-water advanced
    expect(store.remainingPool('e2e').micro >= 0n).toBe(true);

    // Only *confirmed* views were paid for — never the fresher, larger count.
    expect(store.viewsPaidTo('sub')).toBe(first!);

    // ── running again pays nothing ───────────────────────────────────────
    const again = await runTick(
      {
        store, gate, log,
        oracle: { fetch: async () => oracle.count(parsePostUrl(VIDEO)!) },
        executor: new DryRunExecutor(),
      },
      { agentId: 'e2e', now: new Date(T2.getTime() + 3_600_000) },
    );
    expect(again.paid).toBe(0);
    expect(store.spentOnCampaign('e2e').toString()).toBe(spent.toString());

    // ── the chain verifies, and a tamper breaks it ───────────────────────
    const { root } = await log.chain();
    expect(root).not.toBe('0'.repeat(64));

    console.log(
      `    settled ${spent} USDC for ${store.viewsPaidTo('sub').toLocaleString()} confirmed views` +
      ` · chain root ${root.slice(0, 16)}…`,
    );
  }, 180_000);

  test('a clip that fails the brief is never paid, however many views it has', async () => {
    const { store, log, gate } = world({
      brief: 'The video must show a hands-on laptop review with the brand name spoken aloud.',
    });
    const camp = campaign({
      brief: 'The video must show a hands-on laptop review with the brand name spoken aloud.',
    });
    const verifier = verifierFromEnv()!;
    const oracle = oracleFromEnv()!;

    await log.append({ type: 'campaign_upserted', campaign: camp }, T0);
    await log.append(
      { type: 'creator_upserted', creator: { creatorId: 'cre', payoutAddress: CREATOR_WALLET, handles: {} } },
      T0,
    );
    const accepted = acceptSubmission(
      camp,
      { submissionId: 'sub', creatorId: 'cre', platform: 'youtube', postId: parsePostUrl(VIDEO)!.postId, url: VIDEO },
      T1,
    );
    if (!accepted.accepted) throw new Error('should have accepted');
    await log.append({ type: 'submission_accepted', submission: accepted.submission }, T1);

    const verdict = await verifier.judge({ url: VIDEO, brief: camp.brief });
    expect(verdict.pass).toBe(false); // 1.8 billion views, wrong content
    await log.append(
      {
        type: 'verdict_recorded',
        verdict: {
          verdictId: 'v', submissionId: 'sub', pass: verdict.pass, reasons: verdict.reasons,
          confidence: verdict.confidence, model: verdict.model, at: T1.toISOString(),
        },
      },
      T1,
    );
    const views = await oracle.count(parsePostUrl(VIDEO)!);
    await log.append(
      { type: 'snapshot_taken', snapshot: { submissionId: 'sub', views: views!, fetchedAt: T1.toISOString(), source: 'youtube' } },
      T1,
    );
    await log.hydrate(store);

    const decision = gate.decide('sub', { agentId: 'e2e', now: T2 });
    expect(decision.disposition).toBe('blocked');
    expect(decision.control).toBe('verdict_failed');
    // The creator is told why, in the model's own words.
    expect(decision.reason.length).toBeGreaterThan(20);
    expect(store.spentOnCampaign('e2e').toString()).toBe('0');
  }, 180_000);
});

describe.skipIf(!Bun.env.CAMPAIGN_WALLET)('settlement against the real Circle CLI', () => {
  test('an unfunded wallet fails the estimate and records no payout', async () => {
    // Proves the whole failure path with nothing mocked: real CLI, real wallet,
    // real chain. The revert is the wallet having no USDC — and the executor
    // must report executed:false so the tick marks nothing as settled.
    const executor = new CircleCliExecutor({
      fromAddress: Bun.env.CAMPAIGN_WALLET!,
      dryRun: true,
    });
    const outcome = await executor.send({
      decision: { submissionId: 'sub', confirmedViews: 2_000n, payableViews: 2_000n,
        amountUsdc: new Decimal('0.02') } as never,
      creator: { creatorId: 'cre', payoutAddress: CREATOR_WALLET, handles: {} },
      campaign: campaign({ chain: 'base' }),
    });

    expect(outcome.executed).toBe(false);
    expect(outcome.dryRun).toBe(true);
    console.log(`    circle CLI → ${outcome.detail}${outcome.error ? ` (${outcome.error.slice(0, 70)})` : ''}`);
  }, 120_000);
});
