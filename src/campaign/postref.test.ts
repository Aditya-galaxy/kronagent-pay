/**
 * Parsing the link a creator pasted.
 *
 * The tests that matter are the refusals. A confidently wrong post id means
 * fetching someone else's view count and paying against it, so anything not
 * recognised has to come back `undefined` rather than a best guess.
 */

import { describe, expect, test } from 'bun:test';

import { canonicalUrl, parsePostUrl } from './postref';

describe('YouTube, in the shapes people actually paste', () => {
  const id = 'dQw4w9WgXcQ';

  test.each([
    [`https://www.youtube.com/watch?v=${id}`, 'watch'],
    [`https://youtube.com/shorts/${id}`, 'shorts'],
    [`https://youtu.be/${id}`, 'short link'],
    [`https://m.youtube.com/watch?v=${id}`, 'mobile'],
    [`https://www.youtube.com/live/${id}`, 'live'],
    [`https://www.youtube.com/embed/${id}`, 'embed'],
  ])('%s (%s)', (url) => {
    expect(parsePostUrl(url)).toEqual({ platform: 'youtube', postId: id });
  });

  test('tracking parameters do not change the id', () => {
    const ref = parsePostUrl(`https://www.youtube.com/watch?v=${id}&t=42s&si=abcdef`);
    expect(ref?.postId).toBe(id);
  });

  test('a channel or search URL is not a post', () => {
    expect(parsePostUrl('https://www.youtube.com/@someone')).toBeUndefined();
    expect(parsePostUrl('https://www.youtube.com/results?search_query=x')).toBeUndefined();
  });

  test('an id of the wrong length is refused, not truncated', () => {
    expect(parsePostUrl('https://youtu.be/tooshort')).toBeUndefined();
    expect(parsePostUrl(`https://youtu.be/${id}EXTRA`)).toBeUndefined();
  });
});

describe('X', () => {
  test('a status URL resolves', () => {
    expect(parsePostUrl('https://x.com/someone/status/1789012345678901234')).toEqual({
      platform: 'x',
      postId: '1789012345678901234',
    });
  });

  test('the old domain still works', () => {
    expect(parsePostUrl('https://twitter.com/someone/status/1789012345678901234')?.platform).toBe('x');
  });

  test('a trailing /photo/1 does not become the id', () => {
    expect(parsePostUrl('https://x.com/a/status/1789012345678901234/photo/1')?.postId).toBe(
      '1789012345678901234',
    );
  });

  test('a profile is not a post', () => {
    expect(parsePostUrl('https://x.com/someone')).toBeUndefined();
  });
});

describe('refusing rather than guessing', () => {
  test('a platform we cannot verify is not accepted', () => {
    // Instagram and TikTok need app review we do not have. Accepting the URL
    // would promise a check we cannot perform.
    expect(parsePostUrl('https://www.instagram.com/reel/Cabc123/')).toBeUndefined();
    expect(parsePostUrl('https://www.tiktok.com/@a/video/7200000000000000000')).toBeUndefined();
  });

  test('http is refused — a downgrade or a typo, never resolved silently', () => {
    expect(parsePostUrl('http://youtu.be/dQw4w9WgXcQ')).toBeUndefined();
  });

  test('nonsense is undefined rather than an exception', () => {
    for (const bad of ['', '   ', 'not a url', 'javascript:alert(1)', 'file:///etc/passwd']) {
      expect(parsePostUrl(bad)).toBeUndefined();
    }
  });

  test('a lookalike host does not pass', () => {
    // youtube.com.evil.example is not youtube.com.
    expect(parsePostUrl('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ')).toBeUndefined();
  });
});

describe('canonical form', () => {
  test('a parsed ref round-trips to a link we produced', () => {
    const ref = parsePostUrl('https://youtu.be/dQw4w9WgXcQ')!;
    expect(canonicalUrl(ref)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(parsePostUrl(canonicalUrl(ref))).toEqual(ref);
  });
});
