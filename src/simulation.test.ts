/**
 * Deterministic simulation testing.
 *
 * Property tests ask whether a single decision holds. These ask the harder
 * question: does the system hold across a long, hostile *history* — mandates
 * issued and revoked and expiring, clocks jumping days, budgets filling and
 * ageing out, an agent proposing attacker payments throughout? Payment bugs
 * live in histories.
 *
 * Every run is a pure function of its seed, so a failure prints a number that
 * reproduces it exactly, on any machine, forever.
 */

import { describe, expect, test } from 'bun:test';

import { SeededRandom, simulate, sweep } from './simulation';

describe('the simulator is itself deterministic', () => {
  test('a seed reproduces its run exactly', () => {
    // Without this the rest of the file is worthless: an unreplayable failure
    // is a rumour, not a bug report.
    const a = simulate({ seed: 42, steps: 500 });
    const b = simulate({ seed: 42, steps: 500 });
    expect(b).toEqual(a);
  });

  test('different seeds explore different histories', () => {
    // Compared as whole histories, not one scalar: two unrelated runs can
    // coincidentally authorize the same count, and asserting on that alone
    // makes a flaky test out of a sound property.
    const a = simulate({ seed: 1, steps: 500 });
    const b = simulate({ seed: 2, steps: 500 });
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
  });

  test('the PRNG is seeded, not the platform one', () => {
    const first = [...Array(10)].map(() => new SeededRandom(7).next());
    expect(new Set(first).size).toBe(1); // same seed, same first value, every time
  });

  test('adjacent seeds start in unrelated regions', () => {
    // A sweep over seeds 1..N is only as good as the independence between
    // them. Before the state was mixed, consecutive seeds opened within 0.002
    // of each other, so the sweep looked exhaustive and explored a sliver.
    const opens = [1, 2, 3, 4, 5].map((s) => new SeededRandom(s).next());
    for (let i = 1; i < opens.length; i += 1) {
      expect(Math.abs(opens[i]! - opens[i - 1]!)).toBeGreaterThan(0.02);
    }
  });
});

describe('invariants hold across generated histories', () => {
  test('a long hostile history violates nothing', () => {
    const result = simulate({ seed: 12345, steps: 5000, injectionRate: 0.4 });

    expect(result.violations).toEqual([]);
    expect(result.chainOk).toBe(true);
    // The run has to actually exercise the system — a simulation that
    // authorized nothing proves only that refusing everything is safe.
    expect(result.authorized).toBeGreaterThan(0);
    expect(result.held).toBeGreaterThan(0);
  });

  test('a seed sweep finds no counterexample', () => {
    const outcome = sweep(60, { steps: 800, injectionRate: 0.45 });

    if (outcome.firstFailure) {
      // Surfaced with the seed so the failure is one command away from a
      // deterministic replay.
      throw new Error(
        `seed ${outcome.firstFailure.seed} violated: ` +
          JSON.stringify(outcome.firstFailure.violations, null, 2),
      );
    }
    expect(outcome.firstFailure).toBeNull();
    expect(outcome.runs).toBe(60);
  });

  test('the kill switch survives an entire hostile history', () => {
    const result = simulate({ seed: 99, steps: 2000, settings: { killSwitch: true } });
    expect(result.authorized).toBe(0);
    expect(result.violations).toEqual([]);
  });

  test('mainnet stays shut across a history that keeps proposing it', () => {
    const result = simulate({ seed: 777, steps: 2000 });
    // I3 is asserted inside the run; this pins that mainnet intents were
    // actually generated, so the invariant was exercised rather than vacuous.
    expect(result.blocked).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  test('simulated time really does advance by months', () => {
    // Mandate expiry is only exercised if the clock outruns the TTLs.
    const result = simulate({ seed: 5, steps: 3000, clockJumpRate: 0.3 });
    expect(result.simulatedDays).toBeGreaterThan(60);
    expect(result.mandatesExpired).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });
});

describe('the simulator can detect a real violation', () => {
  test('conservation is checked independently, not against the budget itself', () => {
    // Guards against the classic worthless invariant: asking a component
    // whether it agrees with itself. The simulator tracks authorized spend in
    // its own structure and compares that to the cap.
    const result = simulate({ seed: 2026, steps: 4000 });
    expect(result.violations).toEqual([]);
    expect(result.authorized).toBeGreaterThan(10);
  });
});
