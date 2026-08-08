/**
 * The two public doors, which had no tests at all.
 *
 * `intake.ts` is the validation layer between the open internet and a system
 * that moves money. `openCampaign` commits the operator's funds; `submitClip`
 * is reachable by anyone. Neither was exercised by a single test, directly or
 * through the HTTP layer, while every invariant *behind* them was covered by
 * property tests and a 600,000-decision simulation.
 *
 * The bias is understandable and worth naming: the engine is the interesting
 * part, so the engine got the attention. But an engine that upholds every
 * invariant against inputs that never reach it in the shape the tests assumed
 * is upholding them hypothetically. This is where a bad input becomes a
 * campaign.
 *
 * The refusals matter as much as the acceptances. A refusal is only kind if it
 * arrives before the creator does the work, so each one is checked for naming
 * its field and saying why.
 */

import { describe, expect, test } from 'bun:test';

import { MIN_DWELL_HOURS, openCampaign, submitClip } from './intake';
import type { Campaign } from './types';

const NOW = new Date('2026-08-05T12:00:00.000Z');

/** A campaign that should always be accepted, so each test varies one thing. */
const valid = () => ({
  brief: 'Clip the podcast and show the product in the first five seconds.',
  poolUsdc: '100',
  cpmUsdc: '1',
  minCpmUsdc: '0.5',
  maxCpmUsdc: '2',
  perCreatorCapUsdc: '20',
  dwellHours: 24,
  settlementDays: 14,
  platforms: ['youtube'],
  chain: 'base-sepolia',
});

const open = (over: Record<string, unknown> = {}) => openCampaign({ ...valid(), ...over }, NOW);

const campaignOr = (over: Record<string, unknown> = {}): Campaign => {
  const r = open(over);
  if (!r.ok) throw new Error(`fixture invalid: ${r.error}`);
  return r.value;
};

describe('the baseline is genuinely valid', () => {
  test('the fixture opens, so every refusal below is caused by its own change', () => {
    const r = open();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.dwellMs).toBe(24 * 3_600_000);
      expect(r.value.cpmUsdc.toString()).toBe('1');
    }
  });
});

describe('a pool is a promise, so it is checked like one', () => {
  test('a zero or negative pool is refused', () => {
    expect(open({ poolUsdc: '0' }).ok).toBe(false);
    expect(open({ poolUsdc: '-5' }).ok).toBe(false);
  });

  test('more precision than USDC has is refused, never rounded', () => {
    // Rounding here would silently alter what the brand committed.
    const r = open({ cpmUsdc: '1.0000001' });
    expect(r.ok).toBe(false);
  });

  test('a per-creator cap above the pool is refused as the typo it is', () => {
    const r = open({ perCreatorCapUsdc: '500' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('perCreatorCapUsdc');
  });

  test('a rate outside its own band is refused', () => {
    expect(open({ cpmUsdc: '5', minCpmUsdc: '0.5', maxCpmUsdc: '2' }).ok).toBe(false);
    expect(open({ minCpmUsdc: '3', maxCpmUsdc: '1' }).ok).toBe(false);
  });
});

describe('the dwell window cannot be turned off', () => {
  test('a zero dwell is refused, and says why', () => {
    // Without this, a campaign could disable the one mechanic the platform
    // exists for while the platform kept telling both sides that only cleared
    // views get paid. That claim holds for every campaign or it holds for none.
    const r = open({ dwellHours: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.field).toBe('dwellHours');
      expect(r.error).toMatch(/inauthentic views/);
    }
  });

  test('anything under the floor is refused', () => {
    for (const h of [0, 0.5, -1]) expect(open({ dwellHours: h }).ok).toBe(false);
  });

  test('the floor and a full week are both accepted', () => {
    expect(open({ dwellHours: MIN_DWELL_HOURS }).ok).toBe(true);
    expect(open({ dwellHours: 168 }).ok).toBe(true);
  });

  test('longer than a week is refused — the work is already done', () => {
    expect(open({ dwellHours: 169 }).ok).toBe(false);
  });

  test('a settlement window shorter than the dwell is refused', () => {
    // Otherwise the obligation expires before the views can confirm and the
    // guarantee to the creator is theatre.
    const r = open({ dwellHours: 48, settlementDays: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('settlementDays');
  });
});

describe('we refuse what we cannot verify', () => {
  test('a platform we cannot check is refused at intake, not at payout', () => {
    const r = open({ platforms: ['tiktok'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/app review/);
  });

  test('an unknown chain is refused', () => {
    expect(open({ chain: 'solana' }).ok).toBe(false);
  });

  test('an end date in the past is refused', () => {
    expect(open({ endsAt: '2020-01-01T00:00:00.000Z' }).ok).toBe(false);
    expect(open({ endsAt: 'not a date' }).ok).toBe(false);
  });

  test('a brief too short to judge against is refused', () => {
    // The brief is what the verifier compares the clip to. An empty one makes
    // every clip pass, which is worse than no verification.
    expect(open({ brief: 'post it' }).ok).toBe(false);
  });
});

describe('submitting a clip', () => {
  const url = 'https://www.youtube.com/shorts/abc123XYZ_1';

  test('the wallet is the identity — no signup stands between work and payment', () => {
    const r = submitClip(campaignOr(), { payoutAddress: '0x' + 'a'.repeat(40), url }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.creator.payoutAddress).toBe('0x' + 'a'.repeat(40));
      expect(r.value.creator.creatorId).toContain('0x' + 'a'.repeat(40));
    }
  });

  test('terms are frozen at acceptance, not read live at payout', () => {
    // The guarantee to the creator: the brand cannot lower the rate after the
    // edit is done.
    const campaign = campaignOr();
    const r = submitClip(campaign, { payoutAddress: '0x' + 'b'.repeat(40), url }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.submission.acceptedTerms.cpmUsdc.toString()).toBe('1');
      expect(r.value.submission.acceptedTerms.dwellMs).toBe(24 * 3_600_000);
    }
  });

  test('a malformed payout address is refused before any work is done', () => {
    for (const addr of ['', '0x123', 'a'.repeat(42), '0x' + 'z'.repeat(40)]) {
      const r = submitClip(campaignOr(), { payoutAddress: addr, url }, NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.field).toBe('payoutAddress');
    }
  });

  test('an unverifiable link is refused with the reason, not silently accepted', () => {
    const r = submitClip(
      campaignOr(),
      { payoutAddress: '0x' + 'c'.repeat(40), url: 'https://www.tiktok.com/@x/video/123' },
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot|verified/i);
  });

  test('a link to a platform this campaign does not pay on is refused', () => {
    const r = submitClip(
      campaignOr({ platforms: ['x'] }),
      { payoutAddress: '0x' + 'd'.repeat(40), url },
      NOW,
    );
    expect(r.ok).toBe(false);
  });

  test('an unknown campaign is refused rather than creating one', () => {
    const r = submitClip(undefined, { payoutAddress: '0x' + 'e'.repeat(40), url }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('campaignId');
  });

  test('the same clip from the same wallet yields the same submission id', () => {
    // Resubmitting must not create a second claim on the same views.
    const campaign = campaignOr();
    const a = submitClip(campaign, { payoutAddress: '0x' + 'f'.repeat(40), url }, NOW);
    const b = submitClip(campaign, { payoutAddress: '0x' + 'f'.repeat(40), url }, NOW);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value.submission.submissionId).toBe(b.value.submission.submissionId);
  });
});
