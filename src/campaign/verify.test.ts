/**
 * The service other agents buy.
 *
 * The tests worth having are about what it refuses to claim. A verification
 * service that invents the number it exists to report is worse than one that
 * says it does not know yet — so every unanswerable field must come back null
 * with a reason, and never as a plausible-looking zero.
 */

import { describe, expect, test } from 'bun:test';

import { MemoryTrackingStore, verifyClip } from './verify';
import type { ClipVerifier, CountOracle } from './verify';

const URL_IN = 'https://youtu.be/dQw4w9WgXcQ';
const CANON = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const oracleOf = (n: bigint): CountOracle => ({ count: async () => n });
const at = (iso: string) => () => new Date(iso);

const passingVerifier: ClipVerifier = {
  async judge() {
    return { pass: true, reasons: ['shows the product'], confidence: 0.9, model: 'test' };
  },
};

describe('the first call starts the clock', () => {
  test('it reports the count but refuses to claim anything survived', async () => {
    const res = await verifyClip(
      { url: URL_IN },
      { tracking: new MemoryTrackingStore(), oracle: oracleOf(5_000n), now: at('2026-08-05T12:00:00Z') },
    );

    expect(res.url).toBe(CANON);
    expect(res.views.latest).toBe('5000');
    expect(res.views.confirmed).toBeNull();
    expect(res.views.pending).toContain('call again later');
    expect(res.views.trackingSince).toBe('2026-08-05T12:00:00.000Z');
  });

  test('a later call reports what survived between them', async () => {
    const tracking = new MemoryTrackingStore();
    await verifyClip(
      { url: URL_IN },
      { tracking, oracle: oracleOf(5_000n), now: at('2026-08-05T00:00:00Z') },
    );
    const res = await verifyClip(
      { url: URL_IN },
      { tracking, oracle: oracleOf(9_000n), now: at('2026-08-06T06:00:00Z') },
    );

    // Only the aged 5,000 have had time to settle.
    expect(res.views.confirmed).toBe('5000');
    expect(res.views.latest).toBe('9000');
    expect(res.views.pending).toBeNull();
  });

  test('views scrubbed between calls are reported as not surviving', async () => {
    const tracking = new MemoryTrackingStore();
    await verifyClip(
      { url: URL_IN },
      { tracking, oracle: oracleOf(845_000n), now: at('2026-08-05T00:00:00Z') },
    );
    const res = await verifyClip(
      { url: URL_IN },
      { tracking, oracle: oracleOf(8n), now: at('2026-08-06T06:00:00Z') },
    );
    expect(res.views.confirmed).toBe('8');
  });

  test('the same post via a different URL shape shares one history', async () => {
    // Otherwise a caller could reset the clock by pasting a short link.
    const tracking = new MemoryTrackingStore();
    await verifyClip(
      { url: URL_IN },
      { tracking, oracle: oracleOf(1_000n), now: at('2026-08-05T00:00:00Z') },
    );
    const res = await verifyClip(
      { url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' },
      { tracking, oracle: oracleOf(2_000n), now: at('2026-08-06T06:00:00Z') },
    );
    expect(res.views.confirmed).toBe('1000');
  });
});

describe('judging the brief', () => {
  test('a verdict is returned with its reasons and model', async () => {
    const res = await verifyClip(
      { url: URL_IN, brief: 'show the product' },
      {
        tracking: new MemoryTrackingStore(),
        oracle: oracleOf(10n),
        verifier: passingVerifier,
        now: at('2026-08-05T12:00:00Z'),
      },
    );
    expect(res.qualifies).toBe(true);
    expect(res.reasons).toEqual(['shows the product']);
    expect(res.model).toBe('test');
  });

  test('no brief means no verdict, not a default pass', async () => {
    const res = await verifyClip(
      { url: URL_IN },
      { tracking: new MemoryTrackingStore(), oracle: oracleOf(10n), verifier: passingVerifier },
    );
    expect(res.qualifies).toBeNull();
    expect(res.errors).toEqual([]);
  });

  test('a brief with no verifier says so instead of guessing', async () => {
    const res = await verifyClip(
      { url: URL_IN, brief: 'show the product' },
      { tracking: new MemoryTrackingStore(), oracle: oracleOf(10n) },
    );
    expect(res.qualifies).toBeNull();
    expect(res.errors.join(' ')).toContain('no verifier configured');
  });

  test('a verifier that throws does not fail the whole call', async () => {
    // The count is the thing being sold; the verdict is advisory.
    const broken: ClipVerifier = { async judge() { throw new Error('quota exceeded'); } };
    const res = await verifyClip(
      { url: URL_IN, brief: 'x' },
      { tracking: new MemoryTrackingStore(), oracle: oracleOf(77n), verifier: broken },
    );
    expect(res.views.latest).toBe('77');
    expect(res.qualifies).toBeNull();
    expect(res.errors.join(' ')).toContain('quota exceeded');
  });
});

describe('refusing to claim what it cannot check', () => {
  test('an unsupported platform is rejected with the reason', async () => {
    const res = await verifyClip(
      { url: 'https://www.tiktok.com/@a/video/7200000000000000000' },
      { tracking: new MemoryTrackingStore(), oracle: oracleOf(1n) },
    );
    expect(res.url).toBeNull();
    expect(res.errors[0]).toContain('YouTube and X only');
  });

  test('no oracle means no count, reported rather than zeroed', async () => {
    const res = await verifyClip({ url: URL_IN }, { tracking: new MemoryTrackingStore() });
    expect(res.views.latest).toBeNull();
    expect(res.errors.join(' ')).toContain('no view oracle configured');
  });

  test('an oracle that cannot tell does not become a zero', async () => {
    const silent: CountOracle = { count: async () => undefined };
    const res = await verifyClip(
      { url: URL_IN },
      { tracking: new MemoryTrackingStore(), oracle: silent },
    );
    expect(res.views.latest).toBeNull();
    expect(res.errors.join(' ')).toContain('did not return a view count');
  });

  test('an absurd dwell window is capped rather than honoured', async () => {
    const res = await verifyClip(
      { url: URL_IN, dwellHours: 100_000 },
      { tracking: new MemoryTrackingStore(), oracle: oracleOf(1n) },
    );
    expect(res.views.dwellHours).toBe(168);
  });
});
