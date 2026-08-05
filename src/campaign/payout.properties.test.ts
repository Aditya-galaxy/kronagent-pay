/**
 * The money invariants, against randomised campaigns rather than chosen ones.
 *
 * Example tests prove a case; these are meant to find the case nobody thought
 * of. The generator deliberately produces the adversarial shapes: view counts
 * that collapse (a platform scrubbing inauthentic views), counts that spike
 * straight to a payout cap, several creators drawing on one pool at once, and
 * clips whose verdicts fail partway through.
 *
 * Invariant 1 is the one that would end the product if it were false — a
 * campaign that can overspend its pool is a campaign nobody can fund safely.
 */

import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { Decimal } from '../decimal';
import { RollingWindowBudget } from '../budget';
import { MandateStore, issueMandate } from '../mandates';
import { PaymentPolicyEngine } from '../policy';
import { CampaignStore } from './store';
import { PayoutGate } from './payout';
import type { Campaign, Verdict } from './types';

const DWELL = 3_600_000; // 1h, so a short run still crosses it
const STEP = 1_800_000; // 30m per step
const START = Date.parse('2026-08-05T00:00:00.000Z');

/**
 * A view trajectory: any sequence, including one that collapses to nothing.
 *
 * The ceiling is tuned against the pool range on purpose. An earlier version
 * generated up to 500k views against pools of $1–40, so nearly every decision
 * was blocked on the pool before it reached the payment path, and the
 * monotonicity and authorisation properties were only ever exercised by ~74
 * samples out of 4,800. The generator looked thorough and was testing a
 * sliver. These bounds put a typical payout at a few dollars against a pool of
 * tens, so authorisations are common and the pool ceiling is still reached.
 */
const trajectory = fc.array(fc.bigInt({ min: 0n, max: 30_000n }), {
  minLength: 1,
  maxLength: 14,
});

interface Run {
  poolUsdc: string;
  cpmUsdc: string;
  perCreatorCapUsdc: string;
  trajectories: bigint[][];
  verdictPasses: boolean[];
}

const runArb: fc.Arbitrary<Run> = fc.record({
  poolUsdc: fc.integer({ min: 5, max: 100 }).map(String),
  cpmUsdc: fc.constantFrom('0.5', '1', '2'),
  perCreatorCapUsdc: fc.integer({ min: 5, max: 100 }).map(String),
  trajectories: fc.array(trajectory, { minLength: 1, maxLength: 3 }),
  verdictPasses: fc.array(fc.boolean(), { minLength: 1, maxLength: 3 }),
});

const verdict = (submissionId: string, pass: boolean): Verdict => ({
  verdictId: `v-${submissionId}`,
  submissionId,
  pass,
  reasons: pass ? ['meets the brief'] : ['does not meet the brief'],
  confidence: 0.8,
  model: 'test',
  at: new Date(START).toISOString(),
});

/**
 * Drive one campaign to completion and return everything an assertion needs.
 * Payouts are recorded exactly when the gate authorises them, which is the
 * same coupling the live loop has.
 */
function simulate(run: Run) {
  const campaign: Campaign = {
    campaignId: 'camp',
    brief: 'brief',
    poolUsdc: new Decimal(run.poolUsdc),
    cpmUsdc: new Decimal(run.cpmUsdc),
    rateBand: { minUsdc: new Decimal('0.1'), maxUsdc: new Decimal('5') },
    perCreatorCapUsdc: new Decimal(run.perCreatorCapUsdc),
    dwellMs: DWELL,
    platforms: ['youtube'],
    chain: 'base-sepolia',
    status: 'active',
    startsAt: new Date(START - 86_400_000).toISOString(),
    endsAt: new Date(START + 86_400_000 * 30).toISOString(),
  };

  const store = new CampaignStore();
  store.putCampaign(campaign);

  const mandates = new MandateStore();
  const count = run.trajectories.length;
  for (let i = 0; i < count; i += 1) {
    const address = `0xcreator${i}`;
    store.putCreator({ creatorId: `cre-${i}`, payoutAddress: address, handles: {} });
    store.putSubmission({
      submissionId: `sub-${i}`,
      campaignId: 'camp',
      creatorId: `cre-${i}`,
      platform: 'youtube',
      postId: `p-${i}`,
      url: `https://youtube.com/shorts/${i}`,
      submittedAt: new Date(START).toISOString(),
    });
    store.addVerdict(verdict(`sub-${i}`, run.verdictPasses[i] ?? true));
    mandates.put(
      issueMandate({
        counterparty: address,
        maxPerPaymentUsdc: '1000',
        issuedBy: 'operator',
        reason: 'campaign',
        now: new Date(START),
      }),
    );
  }

  const engine = new PaymentPolicyEngine(
    {
      dryRun: true,
      killSwitch: false,
      absoluteMaxPerPaymentUsdc: new Decimal('1000'),
      allowMainnet: false,
    },
    mandates,
    new RollingWindowBudget({ defaultCapUsdc: '100000' }),
  );
  const gate = new PayoutGate(store, engine);

  const amounts: Decimal[] = [];
  const highWater = new Map<string, bigint>();
  const controls: string[] = [];
  let monotonic = true;
  let everNegative = false;
  let paidWithoutAuthorisation = false;

  const steps = Math.max(...run.trajectories.map((t) => t.length));
  for (let step = 0; step < steps; step += 1) {
    const now = new Date(START + step * STEP);
    for (let i = 0; i < count; i += 1) {
      const views = run.trajectories[i]?.[step];
      if (views !== undefined) {
        store.addSnapshot({
          submissionId: `sub-${i}`,
          views,
          fetchedAt: now.toISOString(),
          source: 'youtube',
        });
      }
      const decision = gate.decide(`sub-${i}`, { agentId: 'agent', now });
      controls.push(decision.control);
      if (decision.amountUsdc.micro < 0n) everNegative = true;

      if (decision.disposition === 'auto_pay') {
        if (decision.payment?.disposition !== 'auto_pay') paidWithoutAuthorisation = true;
        const previous = highWater.get(`sub-${i}`) ?? 0n;
        if (decision.confirmedViews < previous) monotonic = false;
        highWater.set(`sub-${i}`, decision.confirmedViews);
        amounts.push(decision.amountUsdc);
        store.recordPayout({
          payoutId: `p-${i}-${step}`,
          submissionId: `sub-${i}`,
          campaignId: 'camp',
          creatorId: `cre-${i}`,
          viewsPaidTo: decision.confirmedViews,
          amountUsdc: decision.amountUsdc,
          at: now.toISOString(),
        });
      }
    }
  }

  return {
    store, campaign, amounts, controls, monotonic, everNegative, paidWithoutAuthorisation, run,
  };
}

/**
 * Guards the guards.
 *
 * A property test only means something if the generator reaches the states the
 * properties are about. This asserts it does, so that a later tweak to the
 * bounds cannot quietly turn the whole file into an expensive no-op — which is
 * exactly what an earlier version of this generator had done.
 */
describe('the generator is not testing a sliver', () => {
  test('every control is reached, and authorisations are not rare', () => {
    const seen = new Map<string, number>();
    fc.assert(
      fc.property(runArb, (run) => {
        for (const control of simulate(run).controls) {
          seen.set(control, (seen.get(control) ?? 0) + 1);
        }
      }),
      { numRuns: 300 },
    );

    for (const control of ['mandated', 'campaign_pool', 'verdict_failed', 'dwell_unmet']) {
      expect(seen.get(control) ?? 0).toBeGreaterThan(20);
    }
    // The properties about payouts are worthless if payouts are a rounding
    // error in the sample.
    const total = [...seen.values()].reduce((a, b) => a + b, 0);
    expect((seen.get('mandated') ?? 0) / total).toBeGreaterThan(0.05);
  });
});

describe('invariants that hold for every campaign', () => {
  test('a campaign can never disburse more than its pool', () => {
    fc.assert(
      fc.property(runArb, (run) => {
        const { store, campaign } = simulate(run);
        expect(store.spentOnCampaign('camp').gt(campaign.poolUsdc)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  test('no creator exceeds the per-creator cap', () => {
    fc.assert(
      fc.property(runArb, (run) => {
        const { store, campaign } = simulate(run);
        for (let i = 0; i < run.trajectories.length; i += 1) {
          expect(
            store.spentOnCreator('camp', `cre-${i}`).gt(campaign.perCreatorCapUsdc),
          ).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });

  test('the views a submission has been paid for never decrease', () => {
    fc.assert(
      fc.property(runArb, (run) => {
        expect(simulate(run).monotonic).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  test('no payout is ever negative, however the view count moves', () => {
    fc.assert(
      fc.property(runArb, (run) => {
        expect(simulate(run).everNegative).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  test('nothing is paid without the payment engine authorising it', () => {
    fc.assert(
      fc.property(runArb, (run) => {
        expect(simulate(run).paidWithoutAuthorisation).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  test('a failed verdict earns nothing, no matter how many views it gets', () => {
    fc.assert(
      fc.property(runArb, (run) => {
        const { store } = simulate(run);
        for (let i = 0; i < run.trajectories.length; i += 1) {
          if (run.verdictPasses[i] === false) {
            expect(store.spentOnCreator('camp', `cre-${i}`).toString()).toBe('0');
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  test('remaining pool is never negative — the number creators are shown', () => {
    fc.assert(
      fc.property(runArb, (run) => {
        const { store } = simulate(run);
        expect(store.remainingPool('camp').micro >= 0n).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
