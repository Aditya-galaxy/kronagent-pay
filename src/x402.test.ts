/**
 * The receiving half.
 *
 * Verification is strict on purpose, and the asymmetry with the paying side is
 * the interesting part: when we spend, a refusal costs a person's attention;
 * when we receive, accepting a bad payment means doing the work for free. So
 * every one of these tests is about refusing something that looks nearly right.
 */

import { describe, expect, test } from 'bun:test';

import { USDC } from './decimal';
import {
  encodePayment,
  paymentRequiredBody,
  paymentRequirements,
  USDC_BASE_SEPOLIA,
  verifyPayment,
  type X402Config,
} from './x402';

const WALLET = '0xAgentWallet0000000000000000000000000000';

const config: X402Config = {
  payTo: WALLET,
  priceUsdc: USDC('1.00'),
  resource: 'https://pay.kronagent.dev/api/job',
  description: 'One researched answer, sources purchased on your behalf.',
};

const goodPayment = (overrides: Record<string, unknown> = {}) =>
  encodePayment({
    amount: '1000000', // 1.00 USDC in micro-units
    network: 'base-sepolia',
    payTo: WALLET,
    payer: '0xBuyerAgent',
    txHash: '0xdeadbeef',
    ...overrides,
  });

describe('the 402 a machine reads', () => {
  test('advertises price, asset, network and recipient', () => {
    const req = paymentRequirements(config);
    expect(req.maxAmountRequired).toBe('1000000'); // exact integers on the wire
    expect(req.asset).toBe(USDC_BASE_SEPOLIA);
    expect(req.payTo).toBe(WALLET);
    expect(req.scheme).toBe('exact');
  });

  test('the body is shaped as an x402 accepts array', () => {
    // So a standard client — or `circle services pay` — consumes it without
    // special-casing us.
    const body = paymentRequiredBody(config) as { x402Version: number; accepts: unknown[] };
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
  });
});

describe('verification refuses everything that is nearly right', () => {
  test('a correct payment is accepted', () => {
    const result = verifyPayment(goodPayment(), config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proof.amountUsdc.toString()).toBe('1');
      expect(result.proof.payer).toBe('0xBuyerAgent');
    }
  });

  test('no header means no service', () => {
    expect(verifyPayment(null, config)).toEqual({ ok: false, reason: 'no X-PAYMENT header' });
  });

  test('underpayment is refused rather than rounded up to goodwill', () => {
    const result = verifyPayment(goodPayment({ amount: '999999' }), config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('underpaid');
  });

  test('overpayment is accepted — the buyer chose to', () => {
    expect(verifyPayment(goodPayment({ amount: '2000000' }), config).ok).toBe(true);
  });

  test('a payment on the wrong network is refused', () => {
    const result = verifyPayment(goodPayment({ network: 'polygon' }), config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('wrong network');
  });

  test('a real payment addressed to someone else is still not payment to us', () => {
    const result = verifyPayment(goodPayment({ payTo: '0xSomeoneElse' }), config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not addressed to this service');
  });

  test('recipient matching is case-insensitive, as addresses are', () => {
    expect(verifyPayment(goodPayment({ payTo: WALLET.toLowerCase() }), config).ok).toBe(true);
  });

  test('a malformed header is refused, not guessed at', () => {
    expect(verifyPayment('not-base64!!', config).ok).toBe(false);
    expect(verifyPayment(encodePayment({ network: 'base-sepolia' }), config).ok).toBe(false);
  });

  test('a non-integer amount is refused', () => {
    const result = verifyPayment(goodPayment({ amount: '1.5' }), config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('integer');
  });
});

describe('signature verification fails closed', () => {
  test('a failing verifier refuses the payment', () => {
    const result = verifyPayment(goodPayment(), config, () => false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('signature did not verify');
  });

  test('a passing verifier accepts it', () => {
    expect(verifyPayment(goodPayment(), config, () => true).ok).toBe(true);
  });

  test('when signatures are required, an unconfigured verifier refuses', () => {
    // An unconfigured verifier must never mean "accept anything".
    process.env['X402_REQUIRE_SIGNATURE'] = 'true';
    try {
      const result = verifyPayment(goodPayment(), config);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('no signature verifier');
    } finally {
      delete process.env['X402_REQUIRE_SIGNATURE'];
    }
  });
});
