/**
 * Policy invariants, proven over generated inputs rather than chosen ones.
 *
 * Example tests prove the engine handles the cases we thought of. That is the
 * weaker claim, and for the component that decides whether money leaves a
 * wallet it is not enough: the interesting failure is the input nobody
 * imagined — an amount one micro-unit over a cap, a counterparty that is the
 * empty string, a mandate that expires on the same millisecond as the payment.
 *
 * So these are stated as properties that must hold for *all* inputs, and
 * fast-check searches for a counterexample. When it finds one it shrinks it to
 * the smallest failing case, which is the difference between "something broke"
 * and "here is the one-line reproduction".
 *
 * The safety properties below are the product's actual promises. If any one of
 * them can be falsified, the system does not do what its README says.
 */

import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { RollingWindowBudget } from './budget';
import { Decimal } from './decimal';
import { MandateStore, issueMandate } from './mandates';
import { PaymentPolicyEngine, SAFE_DEFAULTS, type PaymentPolicySettings } from './policy';
import type { Chain, PaymentIntent } from './schemas';

const CHAINS: Chain[] = ['base-sepolia', 'base', 'eth-sepolia', 'ethereum', 'polygon-amoy', 'polygon'];
const TESTNETS = new Set(['base-sepolia', 'eth-sepolia', 'polygon-amoy']);

/** USDC amounts as micro-units, so generation covers sub-cent and huge values. */
const amountArb = fc
  .bigInt({ min: 1n, max: 10_000_000_000n })
  .map((micro) => Decimal.fromMicro(micro));

const counterpartyArb = fc.constantFrom(
  'https://a.example',
  'https://b.example',
  'https://attacker.example',
  '',
  '0x0000000000000000000000000000000000000000',
);

const intentArb = fc.record({
  intentId: fc.string({ minLength: 1, maxLength: 12 }),
  counterparty: counterpartyArb,
  amountUsdc: amountArb,
  chain: fc.constantFrom(...CHAINS),
  agentId: fc.constantFrom('agent-1', 'agent-2', 'default'),
  purpose: fc.string({ maxLength: 200 }),
}).map((r): PaymentIntent => ({
  ...r,
  rail: 'x402',
  requestedAt: new Date().toISOString(),
}));

const settingsArb = fc.record({
  killSwitch: fc.boolean(),
  allowMainnet: fc.boolean(),
  absoluteMaxPerPaymentUsdc: fc
    .bigInt({ min: 1n, max: 1_000_000_000n })
    .map((m) => Decimal.fromMicro(m)),
}).map((s): PaymentPolicySettings => ({ ...SAFE_DEFAULTS, ...s }));

/** A world with a mandate for 'https://a.example' and nothing else. */
function world(capUsdc = '1000000', mandateCap = '1000000') {
  const mandates = new MandateStore([
    issueMandate({
      counterparty: 'https://a.example',
      maxPerPaymentUsdc: mandateCap,
      issuedBy: 'alice',
      reason: 'property test',
      expiresInDays: 365,
    }),
  ]);
  const budget = new RollingWindowBudget({ defaultCapUsdc: capUsdc });
  return { mandates, budget };
}

describe('safety properties — these are the product promises', () => {
  test('nothing above the absolute ceiling is ever authorized', () => {
    fc.assert(
      fc.property(intentArb, settingsArb, (intent, settings) => {
        const { mandates, budget } = world();
        const decision = new PaymentPolicyEngine(settings, mandates, budget).decide(intent);
        if (intent.amountUsdc.gt(settings.absoluteMaxPerPaymentUsdc)) {
          expect(decision.disposition).not.toBe('auto_pay');
        }
      }),
      { numRuns: 2000 },
    );
  });

  test('an unmandated counterparty is never authorized', () => {
    fc.assert(
      fc.property(intentArb, settingsArb, (intent, settings) => {
        const { mandates, budget } = world();
        const decision = new PaymentPolicyEngine(settings, mandates, budget).decide(intent);
        if (intent.counterparty !== 'https://a.example') {
          expect(decision.disposition).not.toBe('auto_pay');
        }
      }),
      { numRuns: 2000 },
    );
  });

  test('mainnet is never authorized unless explicitly armed', () => {
    fc.assert(
      fc.property(intentArb, settingsArb, (intent, settings) => {
        const { mandates, budget } = world();
        const decision = new PaymentPolicyEngine(settings, mandates, budget).decide(intent);
        if (!TESTNETS.has(intent.chain) && !settings.allowMainnet) {
          expect(decision.disposition).toBe('blocked');
        }
      }),
      { numRuns: 2000 },
    );
  });

  test('the kill switch admits no exceptions', () => {
    fc.assert(
      fc.property(intentArb, settingsArb, (intent, settings) => {
        const { mandates, budget } = world();
        const engine = new PaymentPolicyEngine({ ...settings, killSwitch: true }, mandates, budget);
        expect(engine.decide(intent).disposition).toBe('blocked');
      }),
      { numRuns: 1000 },
    );
  });

  test('an expired mandate authorizes nothing, at any point after expiry', () => {
    fc.assert(
      fc.property(intentArb, fc.integer({ min: 1, max: 10_000 }), (intent, daysPast) => {
        const { mandates, budget } = world();
        const engine = new PaymentPolicyEngine(SAFE_DEFAULTS, mandates, budget);
        const after = new Date(Date.now() + (365 + daysPast) * 86_400_000);
        expect(engine.decide(intent, after).disposition).not.toBe('auto_pay');
      }),
      { numRuns: 500 },
    );
  });
});

describe('conservation — the budget is a real ceiling, not a suggestion', () => {
  test('total authorized spend never exceeds the window cap', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 200_000n }), { minLength: 1, maxLength: 300 }),
        (micros) => {
          const cap = '1';
          const { mandates, budget } = world(cap);
          const engine = new PaymentPolicyEngine(SAFE_DEFAULTS, mandates, budget);

          let authorizedTotal = new Decimal(0n);
          micros.forEach((micro, i) => {
            const intent: PaymentIntent = {
              intentId: `i-${i}`,
              counterparty: 'https://a.example',
              amountUsdc: Decimal.fromMicro(micro),
              rail: 'x402',
              chain: 'base-sepolia',
              agentId: 'default',
              requestedAt: new Date().toISOString(),
            };
            if (engine.decide(intent).disposition === 'auto_pay') {
              // Mirrors the gate: budget is consumed at authorization.
              budget.record({
                agentId: 'default',
                amountUsdc: intent.amountUsdc,
                atMs: Date.now(),
                intentId: intent.intentId,
              });
              authorizedTotal = authorizedTotal.plus(intent.amountUsdc);
            }
          });

          // The invariant the whole drain defence rests on.
          expect(authorizedTotal.gt(new Decimal(cap))).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('totality and determinism', () => {
  test('decide never throws, for any generated intent or settings', () => {
    fc.assert(
      fc.property(intentArb, settingsArb, (intent, settings) => {
        const { mandates, budget } = world();
        // A policy engine that can throw is a policy engine that can be made
        // to fail open by whoever catches the exception.
        expect(() =>
          new PaymentPolicyEngine(settings, mandates, budget).decide(intent),
        ).not.toThrow();
      }),
      { numRuns: 2000 },
    );
  });

  test('the same inputs always produce the same verdict', () => {
    fc.assert(
      fc.property(intentArb, settingsArb, (intent, settings) => {
        const { mandates, budget } = world();
        const engine = new PaymentPolicyEngine(settings, mandates, budget);
        const at = new Date();
        const first = engine.decide(intent, at);
        const second = engine.decide(intent, at);
        expect(second.disposition).toBe(first.disposition);
        expect(second.control).toBe(first.control);
      }),
      { numRuns: 1000 },
    );
  });

  test('every decision names the control that produced it', () => {
    fc.assert(
      fc.property(intentArb, settingsArb, (intent, settings) => {
        const { mandates, budget } = world();
        const decision = new PaymentPolicyEngine(settings, mandates, budget).decide(intent);
        // An unattributed refusal cannot be debugged or appealed.
        expect(decision.control.length).toBeGreaterThan(0);
        expect(decision.reason.length).toBeGreaterThan(0);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('monotonicity — tightening never loosens, loosening never tightens', () => {
  test('lowering the ceiling never turns a refusal into an authorization', () => {
    fc.assert(
      fc.property(
        intentArb,
        fc.bigInt({ min: 1n, max: 1_000_000_000n }),
        fc.bigInt({ min: 1n, max: 1_000_000_000n }),
        (intent, aMicro, bMicro) => {
          const low = Decimal.fromMicro(aMicro < bMicro ? aMicro : bMicro);
          const high = Decimal.fromMicro(aMicro < bMicro ? bMicro : aMicro);
          const { mandates, budget } = world();

          const strict = new PaymentPolicyEngine(
            { ...SAFE_DEFAULTS, absoluteMaxPerPaymentUsdc: low }, mandates, budget,
          ).decide(intent);
          const loose = new PaymentPolicyEngine(
            { ...SAFE_DEFAULTS, absoluteMaxPerPaymentUsdc: high }, mandates, budget,
          ).decide(intent);

          // A stricter ceiling must never authorize something the looser one
          // refused. Non-monotonic policy is unreasonable to operate: an
          // operator tightening a limit would have no idea what they changed.
          if (strict.disposition === 'auto_pay') {
            expect(loose.disposition).toBe('auto_pay');
          }
        },
      ),
      { numRuns: 1500 },
    );
  });
});
