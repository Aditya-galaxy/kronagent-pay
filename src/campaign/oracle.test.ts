/**
 * Where view counts come from.
 *
 * Nearly every test here is a failure mode, because the failure modes are
 * where the money bugs live. **Not one of them may return zero.** A zero looks
 * like a clip nobody watched and silently caps a payout; `undefined` means
 * "could not tell" and leaves the last good snapshot standing.
 */

import { describe, expect, test } from 'bun:test';

import { PlatformOracle, XOracleUnavailable, YouTubeOracle, oracleFromEnv } from './oracle';

const reply = (status: number, body: unknown) =>
  (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;

const withViews = (n: string) => reply(200, { items: [{ statistics: { viewCount: n } }] });

const oracle = (fetchImpl: typeof fetch, log?: (l: string) => void) =>
  new YouTubeOracle({ apiKey: 'k', fetchImpl, log });

const REF = { platform: 'youtube', postId: 'dQw4w9WgXcQ' };

describe('reading a real count', () => {
  test('viewCount comes back as an exact bigint', async () => {
    expect(await oracle(withViews('1543219876')).count(REF)).toBe(1_543_219_876n);
  });

  test('a count beyond Number.MAX_SAFE_INTEGER is not rounded', async () => {
    // JSON gives it to us as a string for exactly this reason. Parsing it as a
    // number would quietly change what a creator is owed.
    const huge = '9007199254740993';
    expect(await oracle(withViews(huge)).count(REF)).toBe(9_007_199_254_740_993n);
  });

  test('a genuine zero is still zero', async () => {
    expect(await oracle(withViews('0')).count(REF)).toBe(0n);
  });

  test('the request asks for statistics and carries the key', async () => {
    let seen = '';
    const spy = (async (url: string) => {
      seen = String(url);
      return { ok: true, status: 200, json: async () => ({ items: [{ statistics: { viewCount: '5' } }] }) };
    }) as unknown as typeof fetch;
    await oracle(spy).count(REF);
    expect(seen).toContain('part=statistics');
    expect(seen).toContain('id=dQw4w9WgXcQ');
    expect(seen).toContain('key=k');
  });
});

describe('every failure means "cannot tell", never zero', () => {
  test('quota exhaustion (403) is undefined, and says so out loud', async () => {
    // Silently returning undefined for a whole day would look like every clip
    // in every campaign going quiet at once.
    const lines: string[] = [];
    expect(await oracle(reply(403, {}), (l) => lines.push(l)).count(REF)).toBeUndefined();
    expect(lines.join(' ')).toContain('quota exhausted');
  });

  test('a deleted or private video is undefined, not zero', async () => {
    // A clip that vanishes after being paid is precisely what dwell is for.
    // Reading it as zero views would be a different, wrong answer.
    expect(await oracle(reply(200, { items: [] })).count(REF)).toBeUndefined();
  });

  test('hidden view counts are undefined', async () => {
    expect(await oracle(reply(200, { items: [{ statistics: {} }] })).count(REF)).toBeUndefined();
  });

  test('a network error is undefined rather than an exception', async () => {
    const broken = (async () => { throw new Error('ETIMEDOUT'); }) as unknown as typeof fetch;
    expect(await oracle(broken).count(REF)).toBeUndefined();
  });

  test('a 500 is undefined', async () => {
    expect(await oracle(reply(500, {})).count(REF)).toBeUndefined();
  });

  test('a nonsense viewCount is undefined rather than NaN', async () => {
    expect(await oracle(withViews('not-a-number')).count(REF)).toBeUndefined();
  });

  test('a negative count is refused', async () => {
    expect(await oracle(withViews('-5')).count(REF)).toBeUndefined();
  });

  test('malformed JSON does not throw', async () => {
    const bad = (async () => ({
      ok: true, status: 200, json: async () => { throw new Error('bad json'); },
    })) as unknown as typeof fetch;
    expect(await oracle(bad).count(REF)).toBeUndefined();
  });
});

describe('routing by platform', () => {
  test('a YouTube oracle refuses to answer for another platform', async () => {
    expect(await oracle(withViews('9')).count({ platform: 'x', postId: '1' })).toBeUndefined();
  });

  test('X reports "cannot tell" because the API is not funded', async () => {
    // Honest state: X clips are accepted and simply never confirm, which the
    // gate shows as dwell_unmet rather than as a rejection.
    expect(await new XOracleUnavailable().count()).toBeUndefined();
  });

  test('the router sends each submission to its platform', async () => {
    const router = new PlatformOracle({
      youtube: oracle(withViews('42')),
      x: new XOracleUnavailable(),
    });
    expect(await router.count({ platform: 'youtube', postId: 'a' })).toBe(42n);
    expect(await router.count({ platform: 'x', postId: '1' })).toBeUndefined();
  });

  test('an unknown platform is undefined, not a crash', async () => {
    const router = new PlatformOracle({ youtube: oracle(withViews('1')) });
    expect(await router.count({ platform: 'tiktok', postId: 'z' })).toBeUndefined();
  });

  test('the ViewOracle shape reads platform and postId off the submission', async () => {
    const router = new PlatformOracle({ youtube: oracle(withViews('77')) });
    const views = await router.fetch({
      submissionId: 's', campaignId: 'c', creatorId: 'cr',
      platform: 'youtube', postId: 'a', url: 'u', submittedAt: 'now',
    } as never);
    expect(views).toBe(77n);
  });
});

describe('configuration', () => {
  test('no key means no oracle — never a stub that answers zero', () => {
    expect(oracleFromEnv({})).toBeUndefined();
    expect(oracleFromEnv({ YOUTUBE_API_KEY: '   ' })).toBeUndefined();
  });

  test('a key produces a router covering both platforms', () => {
    expect(oracleFromEnv({ YOUTUBE_API_KEY: 'k' })).toBeInstanceOf(PlatformOracle);
  });
});
