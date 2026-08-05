/**
 * The dwell mechanic, which is the entire fraud position.
 *
 * The test that matters most is "views scrubbed between snapshots are never
 * paid for" — that is the documented failure it exists to prevent, where a
 * brand paid $1,500 for 845,000 views that were 99.999% bots and only found
 * out after settling.
 */

import { describe, expect, test } from 'bun:test';

import { Decimal } from '../decimal';
import { confirmedViews, earningsFor, hasDwelled, payableViews } from './views';
import type { Snapshot } from './types';

const DWELL = 86_400_000; // 24h
const NOW = new Date('2026-08-05T12:00:00.000Z');

const snap = (fetchedAt: string, views: bigint): Snapshot => ({
  submissionId: 'sub-1',
  views,
  fetchedAt,
  source: 'youtube',
});

const AGED = '2026-08-04T00:00:00.000Z'; // 36h before NOW
const FRESH = '2026-08-05T11:00:00.000Z'; // 1h before NOW

describe('confirming views', () => {
  test('nothing is confirmed until a snapshot has aged past the dwell period', () => {
    // A brand-new clip is worth nothing yet. Fail closed.
    expect(confirmedViews([snap(FRESH, 900_000n)], { dwellMs: DWELL, now: NOW })).toBe(0n);
  });

  test('while views are still climbing, the older smaller count is what pays', () => {
    const snapshots = [snap(AGED, 1_000n), snap(FRESH, 5_000n)];
    expect(confirmedViews(snapshots, { dwellMs: DWELL, now: NOW })).toBe(1_000n);
  });

  test('views scrubbed between snapshots are never paid for', () => {
    // The platform removed 4,200 views as inauthentic. We had not paid for
    // them, because they had not survived. This is the whole design.
    const snapshots = [snap(AGED, 5_000n), snap(FRESH, 800n)];
    expect(confirmedViews(snapshots, { dwellMs: DWELL, now: NOW })).toBe(800n);
  });

  test('a snapshot with an unreadable timestamp cannot authorise anything', () => {
    // Placing it on either side of the window would be a guess, and a guess
    // here is a payout.
    const snapshots = [snap('not-a-date', 9_999_999n), snap(FRESH, 10n)];
    expect(confirmedViews(snapshots, { dwellMs: DWELL, now: NOW })).toBe(0n);
  });

  test('no snapshots at all confirms nothing', () => {
    expect(confirmedViews([], { dwellMs: DWELL, now: NOW })).toBe(0n);
  });
});

describe('telling a wait apart from a rejection', () => {
  test('a clip with only fresh snapshots has not dwelled', () => {
    expect(hasDwelled([snap(FRESH, 5_000n)], { dwellMs: DWELL, now: NOW })).toBe(false);
  });

  test('a clip with an aged snapshot has', () => {
    expect(hasDwelled([snap(AGED, 0n)], { dwellMs: DWELL, now: NOW })).toBe(true);
  });
});

describe('what views earn', () => {
  test('a thousand views at a dollar CPM earns a dollar', () => {
    expect(earningsFor(1_000n, new Decimal('1')).toString()).toBe('1');
  });

  test('partial thousands are paid pro rata', () => {
    expect(earningsFor(1_500n, new Decimal('1')).toString()).toBe('1.5');
  });

  test('sub-micro amounts round down, never up', () => {
    // Truncation underpays by less than a micro-USDC, and underpaying is the
    // only rounding direction that cannot overspend a pool.
    expect(earningsFor(1n, new Decimal('0.0001')).toString()).toBe('0');
  });

  test('no views earns nothing rather than throwing', () => {
    expect(earningsFor(0n, new Decimal('1')).toString()).toBe('0');
    expect(earningsFor(-5n, new Decimal('1')).toString()).toBe('0');
  });
});

describe('what is still owed', () => {
  test('only views beyond the high-water mark are payable', () => {
    expect(payableViews(5_000n, 3_000n)).toBe(2_000n);
  });

  test('a falling count owes nothing — it never claws back', () => {
    // Money that settled on-chain cannot be recalled. A negative payout would
    // be a lie about what this system can do.
    expect(payableViews(1_000n, 3_000n)).toBe(0n);
  });

  test('paying twice for the same views is impossible', () => {
    expect(payableViews(3_000n, 3_000n)).toBe(0n);
  });
});
