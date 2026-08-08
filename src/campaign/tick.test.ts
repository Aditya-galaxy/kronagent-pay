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

/* ─────────────────────── the agent, once it is wired in ─────────────────────── */

const investigatorSaying = (finding: 'clear' | 'watch' | 'hold', reasons: string[] = []) => ({
  calls: 0,
  async investigate(signal: { submissionId: string }) {
    this.calls += 1;
    return { submissionId: signal.submissionId, finding, reasons, wantsMoreData: false, model: 'test' };
  },
});

/** Records what it was asked to send, so "never called" is assertable. */
const spyExecutor = () => {
  const sent: string[] = [];
  const executor: PayoutExecutor = {
    async send({ decision }) {
      sent.push(decision.submissionId);
      return { intentId: 'i', executed: true, dryRun: true, detail: 'ok', settledAt: NOW.toISOString() };
    },
  };
  return { sent, executor };
};

describe('the investigator is consulted, and can only delay', () => {
  test('a hold stops the payment reaching the executor at all', async () => {
    // The property worth having a test for: the finding must interrupt the
    // pass before settlement, not merely be recorded next to a payout that
    // still went out.
    const { store, gate } = world(['a']);
    const { sent, executor } = spyExecutor();
    const inv = investigatorSaying('hold', ['count fell 988 views']);

    const result = await runTick(
      // The oracle reports fewer views than the aged snapshot: the platform
      // scrubbed some. That is what makes the velocity worth investigating.
      { store, gate, oracle: oracleReturning(12n), executor, agent: { investigator: inv } },
      { agentId: 'agent', now: NOW },
    );

    expect(inv.calls).toBe(1);
    expect(sent).toEqual([]);
    expect(result.paid).toBe(0);
    expect(result.held).toBe(1);
    expect(result.investigationsHeld[0]).toContain('count fell 988 views');
    expect(store.viewsPaidTo('a')).toBe(0n);
  });

  test('a clear finding pays exactly as it would have without the agent', async () => {
    const { store, gate } = world(['a']);
    const { sent, executor } = spyExecutor();
    const inv = investigatorSaying('clear');

    const result = await runTick(
      { store, gate, oracle: oracleReturning(12n), executor, agent: { investigator: inv } },
      { agentId: 'agent', now: NOW },
    );
    expect(inv.calls).toBe(1);
    expect(sent).toEqual(['a']);
    expect(result.paid).toBe(1);
  });

  test('watch pays too — it is a note, not a brake', async () => {
    const { store, gate } = world(['a']);
    const { sent, executor } = spyExecutor();
    const result = await runTick(
      { store, gate, oracle: oracleReturning(12n), executor, agent: { investigator: investigatorSaying('watch') } },
      { agentId: 'agent', now: NOW },
    );
    expect(sent).toEqual(['a']);
    expect(result.paid).toBe(1);
  });

  test('an unremarkable clip is never sent to the model', async () => {
    // Steady growth is not worth a model call. This is a cost property, but it
    // is also a privacy one: fewer clips leave the system than would otherwise.
    const { store, gate } = world(['a']);
    const inv = investigatorSaying('hold');
    const result = await runTick(
      { store, gate, oracle: oracleReturning(5_000n), executor: new DryRunExecutor(), agent: { investigator: inv } },
      { agentId: 'agent', now: NOW },
    );
    expect(inv.calls).toBe(0);
    expect(result.paid).toBe(1);
  });

  test('an investigator that throws does not strand an honest creator', async () => {
    // Deliberate: the deterministic controls have already run and said pay. An
    // outage in the judgment layer must not become a freeze on everyone's
    // money — it is recorded as an error and the pass continues.
    const { store, gate } = world(['a']);
    const { sent, executor } = spyExecutor();
    const result = await runTick(
      {
        store, gate, oracle: oracleReturning(12n), executor,
        agent: { investigator: { async investigate() { throw new Error('502 from the model'); } } },
      },
      { agentId: 'agent', now: NOW },
    );
    expect(sent).toEqual(['a']);
    expect(result.errors.join()).toContain('502 from the model');
  });
});

describe('the rate proposer, once it is wired in', () => {
  test('a proposal outside the band leaves the rate where it was, and is recorded', async () => {
    const { store, gate } = world(['a']);
    const result = await runTick(
      {
        store, gate, oracle: oracleReturning(5_000n), executor: new DryRunExecutor(),
        agent: { rate: { async propose() { return { proposedUsdc: '9999', rationale: 'pay me everything' }; } } },
      },
      { agentId: 'agent', now: NOW },
    );
    expect(store.campaign('camp-1')?.cpmUsdc.toString()).toBe('1');
    expect(result.rateChanges[0]).toContain('REFUSED');
  });

  test('an accepted change never reaches terms already accepted', async () => {
    // The whole point of freezing terms at acceptance. If a rate move could
    // reach backwards, the brand would have discretion over work already done.
    const { store, gate } = world(['a']);
    const before = store.submission('a')!.acceptedTerms.cpmUsdc.toString();

    await runTick(
      {
        store, gate, oracle: oracleReturning(5_000n), executor: new DryRunExecutor(),
        agent: { rate: { async propose() { return { proposedUsdc: '1.5', rationale: 'pool barely touched' }; } } },
      },
      { agentId: 'agent', now: NOW },
    );

    expect(store.campaign('camp-1')?.cpmUsdc.toString()).toBe('1.5');
    expect(store.submission('a')!.acceptedTerms.cpmUsdc.toString()).toBe(before);
  });

  test('a proposer that throws does not stop anyone getting paid', async () => {
    const { store, gate } = world(['a']);
    const result = await runTick(
      {
        store, gate, oracle: oracleReturning(5_000n), executor: new DryRunExecutor(),
        agent: { rate: { async propose() { throw new Error('model unavailable'); } } },
      },
      { agentId: 'agent', now: NOW },
    );
    expect(result.paid).toBe(1);
    expect(result.errors.join()).toContain('model unavailable');
  });

  test('no agent at all is a valid configuration — the pass stays mechanical', async () => {
    const { store, gate } = world(['a']);
    const result = await runTick(
      { store, gate, oracle: oracleReturning(5_000n), executor: new DryRunExecutor() },
      { agentId: 'agent', now: NOW },
    );
    expect(result.paid).toBe(1);
    expect(result.rateChanges).toEqual([]);
    expect(result.investigationsHeld).toEqual([]);
  });
});
