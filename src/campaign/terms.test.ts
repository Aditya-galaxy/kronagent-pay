/**
 * Acceptance, and the deal it freezes.
 *
 * The asymmetry these tests exist to close: every other control in this system
 * protects the brand from the agent. This is the only one protecting the
 * creator from the brand, and without it the system reproduces the exact
 * complaint it was built to answer — real work, real views, no payment,
 * because the terms changed underneath.
 */

import { describe, expect, test } from 'bun:test';

import { Decimal } from '../decimal';
import { DEFAULT_SETTLEMENT_WINDOW_MS, acceptSubmission, termsExpired, termsFor } from './terms';
import type { Campaign } from './types';

const NOW = new Date('2026-08-05T12:00:00.000Z');

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  campaignId: 'camp-1',
  brief: 'Clip the podcast.',
  poolUsdc: new Decimal('100'),
  cpmUsdc: new Decimal('1'),
  rateBand: { minUsdc: new Decimal('0.5'), maxUsdc: new Decimal('2') },
  perCreatorCapUsdc: new Decimal('10'),
  dwellMs: 86_400_000,
  settlementWindowMs: DEFAULT_SETTLEMENT_WINDOW_MS,
  platforms: ['youtube'],
  chain: 'base-sepolia',
  status: 'active',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

const input = {
  submissionId: 'sub-1',
  creatorId: 'cre-1',
  platform: 'youtube' as const,
  postId: 'yt-1',
  url: 'https://youtube.com/shorts/1',
};

describe('taking a clip in', () => {
  test('acceptance copies the deal onto the submission', () => {
    const result = acceptSubmission(campaign(), input, NOW);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const terms = result.submission.acceptedTerms;
    expect(terms.cpmUsdc.toString()).toBe('1');
    expect(terms.dwellMs).toBe(86_400_000);
    expect(terms.perCreatorCapUsdc.toString()).toBe('10');
    expect(terms.acceptedAt).toBe(NOW.toISOString());
  });

  test('the terms are a copy, not a live reference to the campaign', () => {
    // A shared Decimal would let a brand mutate the agreed rate after the fact,
    // which is the entire failure this prevents.
    const c = campaign();
    const result = acceptSubmission(c, input, NOW);
    if (!result.accepted) throw new Error('should have accepted');
    c.cpmUsdc = new Decimal('0.25');
    expect(result.submission.acceptedTerms.cpmUsdc.toString()).toBe('1');
  });

  test('the settlement window comfortably outlasts the dwell period', () => {
    // Otherwise the guarantee is theatre: the creator whose views are still
    // settling is precisely the one it protects.
    const terms = termsFor(campaign(), NOW);
    const window = Date.parse(terms.settlementDeadline) - Date.parse(terms.acceptedAt);
    expect(window).toBeGreaterThan(terms.dwellMs * 10);
  });
});

describe('refusing before the work, not after', () => {
  test('a paused campaign takes no new clips', () => {
    const result = acceptSubmission(campaign({ status: 'paused' }), input, NOW);
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('campaign_not_active');
  });

  test('a closed window takes no new clips, and says so up front', () => {
    const result = acceptSubmission(campaign({ endsAt: '2026-08-04T00:00:00.000Z' }), input, NOW);
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('campaign_window_closed');
    expect(result.detail).toContain('before you post');
  });

  test('a platform whose views we cannot verify is refused', () => {
    const result = acceptSubmission(campaign(), { ...input, platform: 'x' }, NOW);
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('platform_not_allowed');
  });
});

describe('when the brand stops being bound', () => {
  test('terms are live inside the window', () => {
    const terms = termsFor(campaign(), NOW);
    expect(termsExpired(terms, new Date('2026-08-10T00:00:00.000Z'))).toBe(false);
  });

  test('and expired past it', () => {
    const terms = termsFor(campaign(), NOW);
    expect(termsExpired(terms, new Date('2026-09-05T00:00:00.000Z'))).toBe(true);
  });

  test('an unreadable deadline reads as still owing, not as expired', () => {
    // The two failure directions are not symmetric. Treating a corrupt date as
    // expired strips a creator of money they earned; treating it as live costs
    // the brand a payout the pool cap already bounds.
    const terms = { ...termsFor(campaign(), NOW), settlementDeadline: 'not-a-date' };
    expect(termsExpired(terms, new Date('2030-01-01T00:00:00.000Z'))).toBe(false);
  });
});
