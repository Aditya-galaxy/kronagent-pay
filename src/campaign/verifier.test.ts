/**
 * The clip verifier.
 *
 * These test the parts that are ours: how a model response is turned into a
 * verdict, and what happens when that response is wrong. **Every malformed
 * answer must fail closed** — a `pass` defaulted to true would be the single
 * worst line in this repo.
 *
 * The model's actual judgment is exercised live in `verifier.live.test.ts`,
 * which is skipped without a key.
 */

import { describe, expect, test } from 'bun:test';

import { DEFAULT_VERIFIER_MODEL, GeminiClipVerifier, verifierFromEnv } from './verifier';

/** Stands in for `ai.models.generateContent`, returning `text`. */
function verifierReturning(text: string | undefined) {
  const v = new GeminiClipVerifier({ apiKey: 'k' });
  const calls: unknown[] = [];
  // The SDK client is the one thing we cannot exercise offline, so it is
  // replaced wholesale rather than mocked at the network layer.
  (v as unknown as { ai: unknown }).ai = {
    models: {
      generateContent: async (req: unknown) => {
        calls.push(req);
        return { text };
      },
    },
  };
  return { v, calls };
}

const JUDGE = { url: 'https://www.youtube.com/watch?v=abc', brief: 'Show the product.' };

describe('turning a response into a verdict', () => {
  test('a well-formed pass comes through with its reasons', async () => {
    const { v } = verifierReturning(
      JSON.stringify({ pass: true, reasons: ['product at 0:03', 'name said at 0:11'], confidence: 0.92 }),
    );
    const verdict = await v.judge(JUDGE);
    expect(verdict.pass).toBe(true);
    expect(verdict.reasons).toEqual(['product at 0:03', 'name said at 0:11']);
    expect(verdict.confidence).toBeCloseTo(0.92);
    expect(verdict.model).toBe(DEFAULT_VERIFIER_MODEL);
  });

  test('a fail carries what was missing, for the creator to read', async () => {
    const { v } = verifierReturning(
      JSON.stringify({ pass: false, reasons: ['the product never appears on screen'], confidence: 0.8 }),
    );
    const verdict = await v.judge(JUDGE);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain('never appears');
  });
});

describe('everything malformed fails closed', () => {
  test('a missing pass field is not a pass', async () => {
    const { v } = verifierReturning(JSON.stringify({ reasons: ['looks fine'], confidence: 1 }));
    expect((await v.judge(JUDGE)).pass).toBe(false);
  });

  test('a truthy non-boolean is not a pass', async () => {
    // "yes", 1, "true" — none of these are `true`.
    for (const value of ['yes', 1, 'true', {}]) {
      const { v } = verifierReturning(JSON.stringify({ pass: value, reasons: [], confidence: 1 }));
      expect((await v.judge(JUDGE)).pass).toBe(false);
    }
  });

  test('unparseable JSON throws rather than returning a verdict', async () => {
    // The caller records the error and the clip goes unjudged, which the gate
    // treats as no_verdict — a hold, not a payment.
    const { v } = verifierReturning('I think this video is great!');
    await expect(v.judge(JUDGE)).rejects.toThrow(/unparseable JSON/);
  });

  test('an empty response throws', async () => {
    const { v } = verifierReturning(undefined);
    await expect(v.judge(JUDGE)).rejects.toThrow(/no verdict/);
  });

  test('a missing confidence becomes 0, not 1', async () => {
    const { v } = verifierReturning(JSON.stringify({ pass: true, reasons: ['ok'] }));
    expect((await v.judge(JUDGE)).confidence).toBe(0);
  });

  test('an out-of-range confidence is clamped', async () => {
    for (const [given, want] of [[99, 1], [-4, 0]] as const) {
      const { v } = verifierReturning(JSON.stringify({ pass: true, reasons: [], confidence: given }));
      expect((await v.judge(JUDGE)).confidence).toBe(want);
    }
  });

  test('reasons that are not an array become empty rather than crashing', async () => {
    const { v } = verifierReturning(JSON.stringify({ pass: true, reasons: 'good', confidence: 1 }));
    expect((await v.judge(JUDGE)).reasons).toEqual([]);
  });
});

describe('what gets sent to the model', () => {
  test('the brief is framed as the operator instruction, the clip as untrusted', async () => {
    const { v, calls } = verifierReturning(JSON.stringify({ pass: true, reasons: [], confidence: 1 }));
    await v.judge(JUDGE);
    const req = calls[0] as {
      config: { systemInstruction: string; temperature: number; mediaResolution: string };
      contents: { parts: { text?: string; fileData?: { fileUri: string } }[] }[];
    };

    expect(req.config.systemInstruction).toContain('UNTRUSTED MATERIAL');
    expect(req.config.systemInstruction).toContain('ONLY instruction you follow');
    const parts = req.contents[0]!.parts;
    expect(parts[0]!.fileData?.fileUri).toBe(JUDGE.url);
    expect(parts[1]!.text).toContain('<brief source="campaign operator">');
  });

  test('media resolution is low by default — about a third the tokens', async () => {
    const { v, calls } = verifierReturning(JSON.stringify({ pass: true, reasons: [], confidence: 1 }));
    await v.judge(JUDGE);
    expect((calls[0] as { config: { mediaResolution: string } }).config.mediaResolution)
      .toBe('MEDIA_RESOLUTION_LOW');
  });

  test('temperature is zero — a verdict that varies is one nobody can appeal', async () => {
    const { v, calls } = verifierReturning(JSON.stringify({ pass: true, reasons: [], confidence: 1 }));
    await v.judge(JUDGE);
    expect((calls[0] as { config: { temperature: number } }).config.temperature).toBe(0);
  });

  test('the response schema has no field an injection could aim at', async () => {
    const { v, calls } = verifierReturning(JSON.stringify({ pass: true, reasons: [], confidence: 1 }));
    await v.judge(JUDGE);
    const schema = (calls[0] as { config: { responseSchema: { properties: object } } })
      .config.responseSchema;
    // No `approved`, no `amount`, no `overrideCap`. The most a suborned verdict
    // can say is "meets the brief", which is one precondition among several.
    expect(Object.keys(schema.properties).sort()).toEqual(['confidence', 'pass', 'reasons']);
  });
});

describe('configuration', () => {
  test('no key means no verifier — never one that always passes', () => {
    expect(verifierFromEnv({})).toBeUndefined();
    expect(verifierFromEnv({ GOOGLE_API_KEY: '  ' })).toBeUndefined();
  });

  test('either env name works', () => {
    expect(verifierFromEnv({ GOOGLE_API_KEY: 'k' })).toBeInstanceOf(GeminiClipVerifier);
    expect(verifierFromEnv({ GEMINI_API_KEY: 'k' })).toBeInstanceOf(GeminiClipVerifier);
  });
});
