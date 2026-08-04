/**
 * The receiving half — our service as an x402 storefront.
 *
 * Circle's prize is for agents *"autonomously making **or receiving**
 * payments as a core part of their business"*, and until now we only built the
 * making half. An agent that buys its inputs and is paid by a human with a
 * credit card is half an agent business; one that is *itself* an x402 endpoint
 * can be discovered and paid by another agent, with no human on either side.
 *
 * That completes the loop the whole system is about:
 *
 *   another agent ──402 pays──►  our research agent  ──402 pays──► data seller
 *                                (governed by mandates)
 *
 * The same protocol, both directions. Revenue in USDC, cost of goods in USDC,
 * and a margin that is arithmetic rather than a projection.
 *
 * x402 is deliberately simple, which is why it works for machines: an
 * unauthenticated request gets `402 Payment Required` plus a JSON body
 * describing exactly what to pay and where. The client signs a payment
 * authorization, retries with an `X-PAYMENT` header, and the server verifies
 * and serves. No account, no checkout page, no session — none of which a
 * machine has any use for.
 */

import { Decimal } from './decimal';

/** What the seller publishes in its 402 response. */
export interface PaymentRequirements {
  readonly scheme: 'exact';
  readonly network: string;
  /** Price in USDC micro-units, as a string — the wire format is exact integers. */
  readonly maxAmountRequired: string;
  readonly resource: string;
  readonly description: string;
  readonly mimeType: string;
  /** Where the USDC goes. Our agent's own wallet. */
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  /** USDC contract on the settlement network. */
  readonly asset: string;
}

export interface X402Config {
  /** Our agent's receiving wallet — the Circle agent wallet address. */
  payTo: string;
  priceUsdc: Decimal;
  network?: string;
  asset?: string;
  resource: string;
  description: string;
}

/** USDC on Base Sepolia. The demo settles on testnet by default. */
export const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

export function paymentRequirements(config: X402Config): PaymentRequirements {
  return {
    scheme: 'exact',
    network: config.network ?? 'base-sepolia',
    maxAmountRequired: config.priceUsdc.micro.toString(),
    resource: config.resource,
    description: config.description,
    mimeType: 'application/json',
    payTo: config.payTo,
    maxTimeoutSeconds: 120,
    asset: config.asset ?? USDC_BASE_SEPOLIA,
  };
}

/**
 * The 402 body. Shaped to x402's `accepts` array so a standard client — or
 * Circle's `circle services pay` — can consume it without special-casing us.
 */
export function paymentRequiredBody(config: X402Config): Record<string, unknown> {
  return {
    x402Version: 1,
    error: 'X-PAYMENT header is required',
    accepts: [paymentRequirements(config)],
  };
}

export interface PaymentProof {
  readonly payer: string;
  readonly amountUsdc: Decimal;
  readonly txHash: string;
  readonly network: string;
}

export type VerificationResult =
  | { ok: true; proof: PaymentProof }
  | { ok: false; reason: string };

/**
 * Verify an `X-PAYMENT` header against what we asked for.
 *
 * Note the asymmetry with the paying side, and that it is deliberate: when we
 * *spend*, a refusal costs a person's attention; when we *receive*, accepting
 * a bad payment costs us the work we are about to do for free. So this is
 * strict — wrong amount, wrong network, wrong recipient, or an unparseable
 * header all mean no service. Under-payment is not rounded up to goodwill.
 *
 * Signature checking is delegated to the facilitator (Circle's, or an x402
 * facilitator) in production. This function's job is the checks that must
 * happen regardless of who verifies the signature, and it fails closed when a
 * verifier is not configured rather than waving payments through.
 */
export function verifyPayment(
  header: string | null,
  config: X402Config,
  verifySignature?: (payload: Record<string, unknown>) => boolean,
): VerificationResult {
  if (!header) return { ok: false, reason: 'no X-PAYMENT header' };

  let payload: Record<string, unknown>;
  try {
    // x402 carries the payload base64-encoded so it survives a header.
    payload = JSON.parse(atob(header)) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'X-PAYMENT header is not valid base64 JSON' };
  }

  const amountRaw = payload['amount'];
  if (typeof amountRaw !== 'string' && typeof amountRaw !== 'number') {
    return { ok: false, reason: 'payment payload carries no amount' };
  }

  let paid: Decimal;
  try {
    paid = Decimal.fromMicro(BigInt(amountRaw));
  } catch {
    return { ok: false, reason: 'amount is not an integer number of micro-units' };
  }

  if (paid.micro < config.priceUsdc.micro) {
    return {
      ok: false,
      reason: `underpaid: ${paid} USDC against a price of ${config.priceUsdc} USDC`,
    };
  }

  const network = String(payload['network'] ?? '');
  if (network !== (config.network ?? 'base-sepolia')) {
    return { ok: false, reason: `wrong network: ${network || 'none'}` };
  }

  const payTo = String(payload['payTo'] ?? '');
  if (payTo.toLowerCase() !== config.payTo.toLowerCase()) {
    // A payment to somebody else is not a payment to us, however real it is.
    return { ok: false, reason: 'payment was not addressed to this service' };
  }

  if (verifySignature && !verifySignature(payload)) {
    return { ok: false, reason: 'payment signature did not verify' };
  }
  if (!verifySignature && process.env['X402_REQUIRE_SIGNATURE'] === 'true') {
    // Fail closed: an unconfigured verifier must not mean "accept anything".
    return { ok: false, reason: 'no signature verifier configured' };
  }

  return {
    ok: true,
    proof: {
      payer: String(payload['payer'] ?? 'unknown'),
      amountUsdc: paid,
      txHash: String(payload['txHash'] ?? ''),
      network,
    },
  };
}

/** Encode a payment payload the way a client would. Used by tests and the demo client. */
export function encodePayment(payload: Record<string, unknown>): string {
  return btoa(JSON.stringify(payload));
}
