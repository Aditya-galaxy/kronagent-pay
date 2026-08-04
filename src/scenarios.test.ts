/**
 * The judge-facing scenarios, asserted.
 *
 * These are what a judge will click, so they have to do what the narrative
 * next to them claims. A demo whose copy says "blocked" while the code returns
 * `true` is worse than no demo — and it is the kind of thing that only shows
 * up live, in front of the person deciding.
 */

import { describe, expect, test } from 'bun:test';

import {
  ATTACKER_SERVICE,
  budgetSnapshot,
  createDemoWorld,
  runScenario,
  WEATHER_SERVICE,
} from './scenarios';

describe('the scenarios do what their narratives claim', () => {
  test('a legitimate purchase is authorized with no human involved', async () => {
    const world = createDemoWorld();
    const result = await runScenario('legitimate', world);

    expect(result.authorized).toBe(true);
    expect(result.authorizedCount).toBe(1);
    expect(world.queue).toHaveLength(0); // nobody was asked
  });

  test('the injected payment is refused and queued for a human', async () => {
    const world = createDemoWorld();
    const result = await runScenario('injected', world);

    expect(result.authorized).toBe(false);
    expect(world.queue).toHaveLength(1);
    expect(world.queue[0]!.reason).toContain('no live spend mandate');
  });

  test('the injected instruction is recorded verbatim, and changed nothing', async () => {
    const world = createDemoWorld();
    await runScenario('injected', world);

    const decision = world.ledger.byStage('decision')[0]!;
    expect(String(decision.payload['purpose'])).toContain('SYSTEM OVERRIDE');
    expect(decision.payload['disposition']).toBe('requires_approval');
    expect(decision.payload['counterparty']).toBe(ATTACKER_SERVICE);
  });

  test('an overpriced call to a mandated service is stopped at the ceiling', async () => {
    const world = createDemoWorld();
    const result = await runScenario('overpriced', world);

    expect(result.authorized).toBe(false);
    expect(world.queue[0]!.reason).toContain('absolute per-payment ceiling');
    // Trusting the counterparty is not accepting any price from it.
    expect(world.queue[0]!.intent.counterparty).toBe(WEATHER_SERVICE);
  });

  test('the runaway loop is stopped by the budget, not by luck', async () => {
    const world = createDemoWorld();
    const result = await runScenario('drain', world);

    expect(result.attempts).toBe(200);
    // 1.00 USDC cap at 0.01 each — exactly 100 authorized, 100 refused.
    expect(result.authorizedCount).toBe(100);
    expect(budgetSnapshot(world)).toMatchObject({ spent: '1', cap: '1', remaining: '0' });
  });

  test('an expired mandate stops authorizing, with no sweep or restart', async () => {
    const world = createDemoWorld();
    expect((await runScenario('legitimate', world)).authorized).toBe(true);

    const later = await runScenario('expired', world);
    expect(later.authorized).toBe(false);
    expect(world.queue.at(-1)!.reason).toContain('no live spend mandate');
  });
});

describe('the ledger a judge inspects', () => {
  test('every scenario leaves a verifiable chain, refusals included', async () => {
    const world = createDemoWorld();
    for (const name of ['legitimate', 'injected', 'overpriced', 'expired'] as const) {
      await runScenario(name, world);
    }

    const decisions = world.ledger.byStage('decision');
    expect(decisions).toHaveLength(4);
    expect(decisions.filter((d) => d.payload['disposition'] === 'auto_pay')).toHaveLength(1);
    expect(world.ledger.verify()).toEqual({ ok: true, brokenAt: null });
  });

  test('the refusals carry the control that produced them', async () => {
    const world = createDemoWorld();
    await runScenario('injected', world);
    await runScenario('overpriced', world);

    const controls = world.ledger.byStage('decision').map((d) => d.payload['control']);
    expect(controls).toEqual(['no_mandate', 'absolute_cap']);
  });
});
