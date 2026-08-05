/**
 * The leash on the agent's one money-moving business decision.
 *
 * The test that matters is that overreach is refused rather than clamped. An
 * agent that has been prompt-injected into demanding a huge CPM must end up
 * with the rate it started on, not with the operator's ceiling.
 */

import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { Decimal } from '../decimal';
import { applyRate, decideRate } from './rate';
import type { Campaign } from './types';

const NOW = new Date('2026-08-05T12:00:00.000Z');

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  campaignId: 'camp-1',
  brief: 'brief',
  poolUsdc: new Decimal('100'),
  cpmUsdc: new Decimal('1'),
  rateBand: { minUsdc: new Decimal('0.5'), maxUsdc: new Decimal('2') },
  perCreatorCapUsdc: new Decimal('10'),
  dwellMs: 86_400_000,
  platforms: ['youtube'],
  chain: 'base-sepolia',
  status: 'active',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

describe('a rate the operator allowed', () => {
  test('a move inside the band is accepted and applied', () => {
    const c = campaign();
    const d = decideRate(c, { proposedUsdc: '1.5', campaignId: 'camp-1' }, NOW);
    expect(d.accepted).toBe(true);
    expect(d.control).toBe('within_band');
    expect(applyRate(c, d)).toBe(true);
    expect(c.cpmUsdc.toString()).toBe('1.5');
  });

  test('the band edges are inclusive — an operator meant what they wrote', () => {
    for (const edge of ['0.5', '2']) {
      const d = decideRate(campaign(), { proposedUsdc: edge, campaignId: 'camp-1' }, NOW);
      expect(d.accepted).toBe(true);
    }
  });

  test("the agent's argument is kept verbatim for whoever reviews the move", () => {
    const d = decideRate(
      campaign(),
      { proposedUsdc: '1.5', campaignId: 'camp-1', rationale: 'pool draining slowly, 3 clips in 48h' },
      NOW,
    );
    expect(d.rationale).toBe('pool draining slowly, 3 clips in 48h');
  });
});

describe('a rate the operator did not allow', () => {
  test('asking for far too much yields nothing, not the ceiling', () => {
    // The whole point. Clamping would hand a manipulated agent the maximum
    // the operator ever allowed, turning overreach into a reward.
    const c = campaign();
    const d = decideRate(c, { proposedUsdc: '50', campaignId: 'camp-1' }, NOW);
    expect(d.accepted).toBe(false);
    expect(d.control).toBe('above_band');
    expect(d.toUsdc.toString()).toBe('1');
    expect(applyRate(c, d)).toBe(false);
    expect(c.cpmUsdc.toString()).toBe('1');
  });

  test('undercutting the floor is refused too', () => {
    const d = decideRate(campaign(), { proposedUsdc: '0.01', campaignId: 'camp-1' }, NOW);
    expect(d.accepted).toBe(false);
    expect(d.control).toBe('below_band');
  });

  test('a paused campaign does not revise its rate', () => {
    const d = decideRate(campaign({ status: 'paused' }), { proposedUsdc: '1.5', campaignId: 'camp-1' }, NOW);
    expect(d.control).toBe('campaign_inactive');
  });

  test('an unreadable proposal leaves the rate alone', () => {
    const c = campaign();
    const d = decideRate(c, { proposedUsdc: 'as much as possible', campaignId: 'camp-1' }, NOW);
    expect(d.accepted).toBe(false);
    expect(c.cpmUsdc.toString()).toBe('1');
  });

  test('proposing the current rate changes nothing', () => {
    const d = decideRate(campaign(), { proposedUsdc: '1', campaignId: 'camp-1' }, NOW);
    expect(d.control).toBe('unchanged');
    expect(d.accepted).toBe(false);
  });
});

describe('the band holds against anything the agent can say', () => {
  test('no proposal, however constructed, moves the rate outside the band', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -1000, max: 1000 }).map(String),
          fc.float({ min: -50, max: 50, noNaN: true }).map((n) => n.toFixed(6)),
          fc.string(),
        ),
        (proposal) => {
          const c = campaign();
          const d = decideRate(c, { proposedUsdc: proposal, campaignId: 'camp-1' }, NOW);
          applyRate(c, d);
          expect(c.rateBand.minUsdc.gt(c.cpmUsdc)).toBe(false);
          expect(c.cpmUsdc.gt(c.rateBand.maxUsdc)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });
});
