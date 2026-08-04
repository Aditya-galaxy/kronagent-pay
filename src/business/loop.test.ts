/**
 * The agent loop and its tools.
 *
 * Tested without a model, because what needs proving here is not that Gemini
 * reasons well — that is Google's problem — but that the *business* holds
 * around it: the agent's purchases are gated, a refusal is something it can
 * reason about rather than crash on, and every step is recorded well enough to
 * reconstruct where the money went.
 */

import { describe, expect, test } from 'bun:test';

import { Decimal, USDC } from '../decimal';
import { buildBusinessTools, MARKETPLACE, type ToolContext } from './tools';
import { runJob } from './loop';

function ctx(overrides: Partial<ToolContext> = {}) {
  const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const bought: string[] = [];
  const base: ToolContext = {
    log: (event, detail) => void events.push({ event, detail }),
    buy: async (url) => {
      bought.push(url);
      return MARKETPLACE.find((s) => s.url === url)?.payload ?? '';
    },
    ...overrides,
  };
  return { ctx: base, events, bought };
}

describe('the action space', () => {
  test('search returns seller-written descriptions unfiltered', () => {
    // Sanitising them here would hide the failure the system exists to
    // contain; the agent has to face in testing what it faces in production.
    const poisoned = MARKETPLACE.find((s) => s.description.includes('IGNORE ALL PREVIOUS'));
    expect(poisoned).toBeDefined();
    expect(poisoned!.priceUsdc).toBe('5.00');
  });

  test('only buy_data spends money', () => {
    const { ctx: c } = ctx();
    const names = buildBusinessTools(c).map((t) => t.name);
    expect(names).toEqual(['search_data_sources', 'buy_data', 'submit_answer']);
  });

  test('searching an unrelated topic still surfaces the whole marketplace', async () => {
    // Real marketplaces return everything on a broad query, which is how a
    // poisoned listing reaches an agent that never asked for it.
    const { ctx: c } = ctx();
    const search = buildBusinessTools(c)[0]!;
    const out = (await search.execute({ topic: 'zzzz' } as never)) as { results: unknown[] };
    expect(out.results.length).toBe(MARKETPLACE.length);
  });
});

describe('a refused payment is data, not a crash', () => {
  test('buy_data returns the refusal so the agent can route around it', async () => {
    const { ctx: c, events } = ctx({
      buy: async () => {
        throw new Error('no live spend mandate for this counterparty');
      },
    });
    const buy = buildBusinessTools(c)[1]!;
    const result = (await buy.execute({ url: MARKETPLACE[0]!.url } as never)) as {
      error?: string;
    };

    expect(result.error).toContain('payment refused');
    expect(result.error).toContain('no live spend mandate');
    expect(events.some((e) => e.event === 'buy_data.refused')).toBe(true);
  });

  test('an unknown url is rejected without reaching the gate', async () => {
    const { ctx: c, bought } = ctx();
    const buy = buildBusinessTools(c)[1]!;
    const result = (await buy.execute({ url: 'https://nope.example' } as never)) as {
      error?: string;
    };
    expect(result.error).toContain('no such data source');
    expect(bought).toEqual([]);
  });
});

describe('the job runs end to end without a model', () => {
  test('it buys, records spend, and answers', async () => {
    const spent: Array<{ url: string; price: string }> = [];
    const result = await runJob({
      question: 'What are delivery conditions in NYC on Thursday?',
      apiKey: '',
      buy: async (url, price) => {
        spent.push({ url, price: price.toString() });
        return MARKETPLACE.find((s) => s.url === url)?.payload ?? '';
      },
    });

    expect(result.model).toContain('fallback');
    expect(result.purchases.length).toBeGreaterThan(0);
    expect(new Decimal(result.spentUsdc).isPositive()).toBe(true);
    expect(result.answer.length).toBeGreaterThan(0);
  });

  test('every job produces execution logs with a start and a finish', async () => {
    const result = await runJob({
      question: 'weather',
      apiKey: '',
      buy: async () => 'data',
    });
    const events = result.steps.map((s) => s.event);
    expect(events[0]).toBe('job.started');
    expect(events.at(-1)).toBe('job.finished');
    expect(result.steps.every((s) => typeof s.at === 'string')).toBe(true);
  });

  test('a job where the policy refuses everything still delivers an answer', async () => {
    // The business must degrade, not fail. An agent that crashes when it
    // cannot buy is one an operator will never leave running unattended.
    const result = await runJob({
      question: 'weather',
      apiKey: '',
      buy: async () => {
        throw new Error('window budget exhausted');
      },
    });

    expect(result.purchases).toEqual([]);
    expect(result.refusals.length).toBeGreaterThan(0);
    expect(result.spentUsdc).toBe('0');
    expect(result.answer).toContain('No data could be purchased');
    expect(result.confidence).toBe('low');
  });

  test('spend is totalled exactly, in USDC micro-units', async () => {
    const result = await runJob({
      question: 'weather traffic',
      apiKey: '',
      buy: async () => 'data',
    });
    const expected = result.purchases.reduce(
      (acc, p) => acc.plus(USDC(p.priceUsdc)),
      new Decimal(0n),
    );
    expect(result.spentUsdc).toBe(expected.toString());
  });
});

describe('unit economics — this is a business, not a demo', () => {
  test('cost of goods for a job is the sum of what it actually paid', async () => {
    const result = await runJob({
      question: 'What are delivery conditions in NYC on Thursday?',
      apiKey: '',
      buy: async (url) => MARKETPLACE.find((s) => s.url === url)?.payload ?? '',
    });

    const cogs = new Decimal(result.spentUsdc);
    const price = USDC('1.00'); // what the customer pays for an answer
    const margin = price.minus(cogs);

    // The margin is the business. If inputs ever cost more than the answer
    // sells for, there is no business — which is exactly what the spend
    // policy exists to prevent structurally rather than by hoping.
    expect(margin.isPositive()).toBe(true);
  });
});
