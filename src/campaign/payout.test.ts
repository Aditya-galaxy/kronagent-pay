/**
 * The payout gate's order of refusal.
 *
 * Each test pins one rung of the ladder, because the *order* is the design: a
 * clip that failed the brief must never reach the pool check, and a payout
 * that would breach the pool must never reach the payment engine. Testing the
 * controls individually without pinning their sequence would let a refactor
 * quietly reorder them.
 */

import { beforeEach, describe, expect, test } from 'bun:test';

import { Decimal } from '../decimal';
import { RollingWindowBudget } from '../budget';
import { MandateStore, issueMandate } from '../mandates';
import { PaymentPolicyEngine } from '../policy';
import { CampaignStore } from './store';
import { PayoutGate } from './payout';
import { termsFor } from './terms';
import type { Campaign, Creator, Snapshot, Submission, Verdict } from './types';

const DWELL = 86_400_000;
const NOW = new Date('2026-08-05T12:00:00.000Z');
const AGED = '2026-08-04T00:00:00.000Z';
const FRESH = '2026-08-05T11:00:00.000Z';
const WALLET = '0xcreator';

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  campaignId: 'camp-1',
  brief: 'Clip the podcast. Show the product. Say the name.',
  poolUsdc: new Decimal('10'),
  cpmUsdc: new Decimal('1'),
  rateBand: { minUsdc: new Decimal('0.5'), maxUsdc: new Decimal('2') },
  perCreatorCapUsdc: new Decimal('3'),
  dwellMs: DWELL,
  settlementWindowMs: 14 * 86_400_000,
  platforms: ['youtube'],
  chain: 'base-sepolia',
  status: 'active',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

const CREATOR: Creator = {
  creatorId: 'cre-1',
  payoutAddress: WALLET,
  handles: { youtube: '@clipper' },
};

const ACCEPTED_AT = new Date('2026-08-03T00:00:00.000Z');

const submissionFor = (c: Campaign): Submission => ({
  submissionId: 'sub-1',
  campaignId: 'camp-1',
  creatorId: 'cre-1',
  platform: 'youtube',
  postId: 'yt-abc',
  url: 'https://youtube.com/shorts/abc',
  submittedAt: ACCEPTED_AT.toISOString(),
  acceptedTerms: termsFor(c, ACCEPTED_AT),
});

const verdict = (pass: boolean): Verdict => ({
  verdictId: `v-${pass}`,
  submissionId: 'sub-1',
  pass,
  reasons: pass ? ['shows the product', 'says the name'] : ['product never appears'],
  confidence: 0.9,
  model: 'test',
  at: '2026-08-04T00:00:00.000Z',
});

const snap = (fetchedAt: string, views: bigint): Snapshot => ({
  submissionId: 'sub-1',
  views,
  fetchedAt,
  source: 'youtube',
});

let store: CampaignStore;
let gate: PayoutGate;

function build(over: Partial<Campaign> = {}) {
  const c = campaign(over);
  store = new CampaignStore();
  store.putCampaign(c);
  store.putCreator(CREATOR);
  store.putSubmission(submissionFor(c));

  const mandates = new MandateStore([
    issueMandate({
      counterparty: WALLET,
      maxPerPaymentUsdc: '5',
      issuedBy: 'operator',
      reason: 'campaign payouts',
      now: NOW,
    }),
  ]);
  const engine = new PaymentPolicyEngine(
    {
      dryRun: true,
      killSwitch: false,
      absoluteMaxPerPaymentUsdc: new Decimal('5'),
      allowMainnet: false,
    },
    mandates,
    new RollingWindowBudget({ defaultCapUsdc: '100' }),
  );
  gate = new PayoutGate(store, engine);
}

const decide = () => gate.decide('sub-1', { agentId: 'agent-1', now: NOW });

beforeEach(() => build());

describe('preconditions, before money is ever considered', () => {
  test('an unknown submission is blocked rather than guessed at', () => {
    const d = gate.decide('nope', { agentId: 'agent-1', now: NOW });
    expect(d.disposition).toBe('blocked');
    expect(d.control).toBe('unknown_entity');
  });

  test('a paused campaign still settles work it already accepted', () => {
    // The asymmetry this closes. Every other control protects the brand from
    // the agent; this is the one that protects the creator from the brand.
    // Pausing refuses *new* clips at acceptance — it does not abandon work
    // already taken, which is precisely the documented complaint.
    build({ status: 'paused' });
    store.addVerdict(verdict(true));
    store.addSnapshot(snap(AGED, 2_000n));
    const d = decide();
    expect(d.disposition).toBe('auto_pay');
    expect(d.amountUsdc.toString()).toBe('2');
  });

  test('a campaign that has ended still settles work it already accepted', () => {
    build({ endsAt: '2026-08-04T00:00:00.000Z' });
    store.addVerdict(verdict(true));
    store.addSnapshot(snap(AGED, 2_000n));
    expect(decide().disposition).toBe('auto_pay');
  });

  test('a rate cut after acceptance does not reprice agreed work', () => {
    // The clip was accepted at 1 USDC/1k. The brand dropping to 0.5 afterwards
    // applies to new clips, not this one.
    build();
    store.campaign('camp-1')!.cpmUsdc = new Decimal('0.5');
    store.addVerdict(verdict(true));
    store.addSnapshot(snap(AGED, 2_000n));
    expect(decide().amountUsdc.toString()).toBe('2');
  });

  test('but the brand stops being bound once the settlement window closes', () => {
    build();
    store.addVerdict(verdict(true));
    store.addSnapshot(snap(AGED, 2_000n));
    const late = new Date('2026-09-01T00:00:00.000Z'); // 14d window expired
    const d = gate.decide('sub-1', { agentId: 'agent-1', now: late });
    expect(d.disposition).toBe('blocked');
    expect(d.control).toBe('terms_expired');
  });

  test('an unchecked clip is never paid', () => {
    store.addSnapshot(snap(AGED, 5_000n));
    expect(decide().control).toBe('no_verdict');
  });

  test('a clip that failed the brief is blocked, and the creator is told why', () => {
    store.addVerdict(verdict(false));
    store.addSnapshot(snap(AGED, 5_000n));
    const d = decide();
    expect(d.control).toBe('verdict_failed');
    expect(d.reason).toContain('product never appears');
  });
});

describe('the dwell gate', () => {
  beforeEach(() => store.addVerdict(verdict(true)));

  test('a clip whose views have not settled is held, not rejected', () => {
    store.addSnapshot(snap(FRESH, 900_000n));
    const d = decide();
    expect(d.disposition).toBe('held');
    expect(d.control).toBe('dwell_unmet');
    expect(d.reason).toContain('not a rejection');
  });

  test('views scrubbed before they settled are simply never paid for', () => {
    // The $1,500-for-845k-bot-views failure, prevented by arithmetic rather
    // than by out-detecting a fraud ring.
    store.addSnapshot(snap(AGED, 845_000n));
    store.addSnapshot(snap(FRESH, 8n));
    const d = decide();
    expect(d.confirmedViews).toBe(8n);
    expect(d.amountUsdc.toString()).toBe('0.008');
  });
});

describe('the money ladder', () => {
  beforeEach(() => {
    store.addVerdict(verdict(true));
    store.addSnapshot(snap(AGED, 2_000n));
    store.addSnapshot(snap(FRESH, 9_000n));
  });

  test('a clean submission is authorised and priced off confirmed views only', () => {
    const d = decide();
    expect(d.disposition).toBe('auto_pay');
    expect(d.confirmedViews).toBe(2_000n);
    expect(d.payableViews).toBe(2_000n);
    expect(d.amountUsdc.toString()).toBe('2');
    expect(d.payment?.control).toBe('mandated');
  });

  test('a settled payout leaves nothing further owed', () => {
    store.recordPayout({
      payoutId: 'p-1',
      submissionId: 'sub-1',
      campaignId: 'camp-1',
      creatorId: 'cre-1',
      viewsPaidTo: 2_000n,
      amountUsdc: new Decimal('2'),
      at: NOW.toISOString(),
    });
    const d = decide();
    expect(d.disposition).toBe('no_op');
    expect(d.control).toBe('nothing_payable');
  });

  test('the pool is a budget, so breaching it is blocked and not escalated', () => {
    build({ poolUsdc: new Decimal('1') });
    store.addVerdict(verdict(true));
    store.addSnapshot(snap(AGED, 2_000n));
    const d = decide();
    expect(d.disposition).toBe('blocked');
    expect(d.control).toBe('campaign_pool');
  });

  test('one creator cannot take the whole campaign', () => {
    // Accepted under a 1 USDC cap, so that is the cap that binds.
    build({ perCreatorCapUsdc: new Decimal('1') });
    store.addVerdict(verdict(true));
    store.addSnapshot(snap(AGED, 2_000n));
    const d = decide();
    expect(d.disposition).toBe('requires_approval');
    expect(d.control).toBe('per_creator_cap');
  });

  test('the payment engine still gets the last word', () => {
    // Pool and creator cap both fine; the absolute ceiling is not. The gate
    // must not be able to authorise past the engine it delegates to.
    build({ perCreatorCapUsdc: new Decimal('100'), poolUsdc: new Decimal('100') });
    store.addVerdict(verdict(true));
    store.addSnapshot(snap(AGED, 9_000n)); // 9 USDC, over the 5 USDC ceiling
    const d = decide();
    expect(d.disposition).toBe('requires_approval');
    expect(d.control).toBe('absolute_cap');
  });
});
