/**
 * One pass of the agent, and the orderings that keep it honest.
 *
 * The tests that matter are the failure ones: a settlement that fails must not
 * mark views as paid, and one broken clip must not stop the rest of the
 * campaign paying out.
 */

import { describe, expect, test } from 'bun:test';

import { Decimal } from '../decimal';
import { RollingWindowBudget } from '../budget';
import { MandateStore, issueMandate } from '../mandates';
import { PaymentPolicyEngine } from '../policy';
import { CampaignStore } from './store';
import { PayoutGate } from './payout';
import { termsFor } from './terms';
import { MemoryBlobStore } from './persistence';
import { EventLog } from './eventlog';
import { DryRunExecutor, runTick } from './tick';
import type { PayoutExecutor, ViewOracle } from './tick';
import type { Campaign, Submission } from './types';

const NOW = new Date('2026-08-05T12:00:00.000Z');
const DWELL = 86_400_000;

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  campaignId: 'camp-1',
  brief: 'Clip the podcast.',
  poolUsdc: new Decimal('100'),
  cpmUsdc: new Decimal('1'),
  rateBand: { minUsdc: new Decimal('0.5'), maxUsdc: new Decimal('2') },
  perCreatorCapUsdc: new Decimal('50'),
  dwellMs: DWELL,
  settlementWindowMs: 14 * 86_400_000,
  platforms: ['youtube'],
  chain: 'base-sepolia',
  status: 'active',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

const submission = (id: string, c: Campaign = campaign()): Submission => ({
  submissionId: id,
  campaignId: 'camp-1',
  creatorId: `cre-${id}`,
  platform: 'youtube',
  postId: id,
  url: `https://youtube.com/shorts/${id}`,
  submittedAt: '2026-08-02T00:00:00.000Z',
  acceptedTerms: termsFor(c, new Date('2026-08-02T00:00:00.000Z')),
});

/** A store with `ids` submissions, each already verified and dwelled. */
function world(ids: string[], over: Partial<Campaign> = {}) {
  const c = campaign(over);
  const store = new CampaignStore();
  store.putCampaign(c);
  const mandates = new MandateStore();

  for (const id of ids) {
    store.putCreator({ creatorId: `cre-${id}`, payoutAddress: `0x${id}`, handles: {} });
    store.putSubmission(submission(id, c));
    store.addVerdict({
      verdictId: `v-${id}`,
      submissionId: id,
      pass: true,
      reasons: ['meets the brief'],
      confidence: 0.9,
      model: 'test',
      at: '2026-08-03T00:00:00.000Z',
    });
    // An aged snapshot, so the dwell period is already satisfied.
    store.addSnapshot({
      submissionId: id,
      views: 1_000n,
      fetchedAt: '2026-08-04T00:00:00.000Z',
      source: 'youtube',
    });
    mandates.put(
      issueMandate({
        counterparty: `0x${id}`,
        maxPerPaymentUsdc: '50',
        issuedBy: 'operator',
        reason: 'campaign payouts',
        now: NOW,
      }),
    );
  }

  const gate = new PayoutGate(
    store,
    new PaymentPolicyEngine(
      {
        dryRun: true,
        killSwitch: false,
        absoluteMaxPerPaymentUsdc: new Decimal('50'),
        allowMainnet: false,
      },
      mandates,
      new RollingWindowBudget({ defaultCapUsdc: '1000' }),
    ),
  );
  return { store, gate };
}

const oracleReturning = (views: bigint): ViewOracle => ({ fetch: async () => views });

describe('a normal pass', () => {
  test('confirmed views are paid and the pool goes down', async () => {
    const { store, gate } = world(['a', 'b']);
    const result = await runTick(
      { store, gate, oracle: oracleReturning(5_000n), executor: new DryRunExecutor() },
      { agentId: 'agent', now: NOW },
    );

    expect(result.paid).toBe(2);
    expect(result.submissions).toBe(2);
    // Only the aged 1,000 views are confirmed, not the fresh 5,000.
    expect(result.totalPaidUsdc.toString()).toBe('2');
    expect(store.remainingPool('camp-1').toString()).toBe('98');
    expect(result.errors).toEqual([]);
  });

  test('running twice pays nothing the second time', async () => {
    const { store, gate } = world(['a']);
    const deps = { store, gate, oracle: oracleReturning(5_000n), executor: new DryRunExecutor() };
    await runTick(deps, { agentId: 'agent', now: NOW });
    const second = await runTick(deps, { agentId: 'agent', now: NOW });

    expect(second.paid).toBe(0);
    expect(second.decisions[0]?.control).toBe('nothing_payable');
  });

  test('a paused campaign still settles the clips it accepted', async () => {
    // The loop must not filter on `active`, or it would honour the agreed
    // terms in the gate while never asking the gate.
    const { store, gate } = world(['a'], { status: 'paused' });
    const result = await runTick(
      { store, gate, oracle: oracleReturning(5_000n), executor: new DryRunExecutor() },
      { agentId: 'agent', now: NOW },
    );
    expect(result.campaigns).toBe(1);
    expect(result.paid).toBe(1);
  });

  test('a draft campaign has nothing to settle and is skipped', async () => {
    const { store, gate } = world(['a'], { status: 'draft' });
    const result = await runTick(
      { store, gate, oracle: oracleReturning(5_000n), executor: new DryRunExecutor() },
      { agentId: 'agent', now: NOW },
    );
    expect(result.campaigns).toBe(0);
  });
});

describe('when something goes wrong', () => {
  test('a failed settlement does not mark the views as paid', async () => {
    // The important one. Recording first would settle these views forever and
    // the creator would simply never be paid for them.
    const { store, gate } = world(['a']);
    const failing: PayoutExecutor = {
      async send() {
        return {
          intentId: 'x',
          executed: false,
          dryRun: false,
          detail: 'rpc rejected the transfer',
          error: 'insufficient gas',
          settledAt: NOW.toISOString(),
        };
      },
    };

    const result = await runTick(
      { store, gate, oracle: oracleReturning(2_000n), executor: failing },
      { agentId: 'agent', now: NOW },
    );

    expect(result.paid).toBe(0);
    expect(result.errors[0]).toContain('insufficient gas');
    expect(store.viewsPaidTo('a')).toBe(0n);
    expect(store.remainingPool('camp-1').toString()).toBe('100');
  });

  test('one clip failing does not stop the others being paid', async () => {
    const { store, gate } = world(['a', 'b', 'c']);
    const flaky: ViewOracle = {
      async fetch(s) {
        if (s.submissionId === 'b') throw new Error('youtube timed out');
        return 4_000n;
      },
    };

    const result = await runTick(
      { store, gate, oracle: flaky, executor: new DryRunExecutor() },
      { agentId: 'agent', now: NOW },
    );

    expect(result.paid).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('youtube timed out');
  });

  test('an oracle that cannot tell does not pay against a guess', async () => {
    // `undefined` is "could not tell", not zero. The last good snapshot stands
    // and the gate decides on that rather than on an invented number.
    const { store, gate } = world(['a']);
    const silent: ViewOracle = { fetch: async () => undefined };
    const result = await runTick(
      { store, gate, oracle: silent, executor: new DryRunExecutor() },
      { agentId: 'agent', now: NOW },
    );
    expect(result.paid).toBe(1);
    expect(result.totalPaidUsdc.toString()).toBe('1'); // the aged 1,000 views
    expect(store.snapshots('a')).toHaveLength(1); // nothing invented
  });
});

describe('durability', () => {
  test('a tick persists, and a fresh store resumes without double paying', async () => {
    const blobs = new MemoryBlobStore();
    const log = new EventLog(blobs);
    const first = world(['a']);
    // The campaign itself has to be on the log too, or a replay has nothing.
    await log.append({ type: 'campaign_upserted', campaign: campaign() });
    await log.append({ type: 'creator_upserted', creator: { creatorId: 'cre-a', payoutAddress: '0xa', handles: {} } });
    await log.append({ type: 'submission_accepted', submission: submission('a') });
    await runTick(
      { ...first, oracle: oracleReturning(3_000n), executor: new DryRunExecutor(), log },
      { agentId: 'agent', now: NOW },
    );

    // A new instance, as Cloud Run would give us after scaling to zero.
    const restored = new CampaignStore();
    await log.hydrate(restored);
    expect(restored.viewsPaidTo('a')).toBe(1_000n);
    expect(restored.spentOnCampaign('camp-1').toString()).toBe('1');
  });
});
