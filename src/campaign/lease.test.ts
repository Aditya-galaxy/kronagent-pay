/**
 * The cross-instance guard.
 *
 * The property under test is not "a lease exists" but "two instances that
 * never talk to each other cannot both settle in the same window". Every test
 * here therefore uses two independent callers over one shared store.
 */

import { describe, expect, test } from 'bun:test';

import { acquireTickLease, DEFAULT_LEASE_WINDOW_MS, leaseKeyFor, type LeaseStore } from './lease';
import { MemoryBlobStore } from './persistence';

const NOW = new Date('2026-08-05T12:00:00.000Z');
const WINDOW = 5 * 60 * 1000;

describe('the window is derived, never negotiated', () => {
  test('two instances at the same moment compute the same key', () => {
    // The whole mechanism. Nothing is exchanged between instances.
    expect(leaseKeyFor(NOW, WINDOW)).toBe(leaseKeyFor(new Date(NOW), WINDOW));
  });

  test('clocks differing by less than a window still agree', () => {
    const skewed = new Date(NOW.getTime() + 30_000);
    expect(leaseKeyFor(skewed, WINDOW)).toBe(leaseKeyFor(NOW, WINDOW));
  });

  test('a later window is a different key, so the next pass simply proceeds', () => {
    const next = new Date(NOW.getTime() + WINDOW);
    expect(leaseKeyFor(next, WINDOW)).not.toBe(leaseKeyFor(NOW, WINDOW));
  });

  test('the default window is shorter than the hourly schedule', () => {
    // Longer than the schedule would silently drop every other pass.
    expect(DEFAULT_LEASE_WINDOW_MS).toBeLessThan(60 * 60 * 1000);
  });
});

describe('only one instance holds a window', () => {
  test('the second instance is refused', async () => {
    const shared = new MemoryBlobStore();
    const a = await acquireTickLease(shared, { now: NOW, windowMs: WINDOW, holder: 'instance-a' });
    const b = await acquireTickLease(shared, { now: NOW, windowMs: WINDOW, holder: 'instance-b' });
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(false);
    expect(b.reason).toContain('another instance');
  });

  test('a simultaneous race still produces exactly one winner', async () => {
    const shared = new MemoryBlobStore();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        acquireTickLease(shared, { now: NOW, windowMs: WINDOW, holder: `i-${i}` }),
      ),
    );
    expect(results.filter((r) => r.acquired)).toHaveLength(1);
  });

  test('the next window is claimable by anyone', async () => {
    const shared = new MemoryBlobStore();
    await acquireTickLease(shared, { now: NOW, windowMs: WINDOW });
    const next = await acquireTickLease(shared, {
      now: new Date(NOW.getTime() + WINDOW), windowMs: WINDOW,
    });
    expect(next.acquired).toBe(true);
  });

  test('the holder is recorded, so a stuck window is diagnosable', async () => {
    const shared = new MemoryBlobStore();
    const { key } = await acquireTickLease(shared, { now: NOW, windowMs: WINDOW, holder: 'instance-a' });
    expect(JSON.parse((await shared.get(key))!).holder).toBe('instance-a');
  });
});

describe('an unreachable store refuses rather than assumes', () => {
  test('a throwing store yields no lease', async () => {
    // Fails closed on purpose: unable to tell whether another instance is
    // settling, we do not settle. A missed pass costs an hour. A duplicated
    // pass costs money.
    const broken: LeaseStore = {
      async putIfAbsent() { throw new Error('GCS 503'); },
      async get() { return undefined; },
    };
    const r = await acquireTickLease(broken, { now: NOW, windowMs: WINDOW });
    expect(r.acquired).toBe(false);
    expect(r.reason).toMatch(/refusing to settle/);
  });
});
