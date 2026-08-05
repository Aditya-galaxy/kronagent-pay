/**
 * Circle's live Agent Marketplace.
 *
 * This replaces the hand-written catalogue the demo started with. Circle's
 * Discovery API is genuinely public — *"no authentication, no API key, and no
 * Circle account required"* — so the agent shops a real marketplace of ~958
 * services with real prices and real sellers, and anyone judging this can
 * verify every listing independently with `curl`.
 *
 *     GET https://api.circle.com/v2/x402/discovery/resources
 *
 * Two properties of the real data matter more than the realism:
 *
 * **Everything settles on mainnet.** Listings quote `eip155:8453` (Base),
 * `eip155:1` (Ethereum) and `eip155:137` (Polygon) — no testnets. So paying a
 * real marketplace service means spending real money, and our mainnet guard
 * refuses it until an operator explicitly arms mainnet. That is not a demo
 * limitation; it is the control doing its job against a live catalogue.
 *
 * **Every descriptive field is written by the seller.** `description`,
 * `provider.description`, `tags` — all of it is text a counterparty controls
 * and the model reads. We pass it to the model verbatim. Sanitising it here
 * would hide the exact failure the policy engine exists to contain, and would
 * also be a lie about what an agent faces in production.
 */

import { Decimal } from '../decimal';

const DISCOVERY = 'https://api.circle.com/v2/x402/discovery/resources';

/** CAIP-2 identifiers as they appear in listings, mapped to our chain names. */
const CHAIN_BY_CAIP2: Record<string, string> = {
  'eip155:1': 'ethereum',
  'eip155:8453': 'base',
  'eip155:137': 'polygon',
  'eip155:11155111': 'eth-sepolia',
  'eip155:84532': 'base-sepolia',
  'eip155:80002': 'polygon-amoy',
};

export type ServiceCategory =
  | 'FINANCIAL_ANALYSIS'
  | 'SOCIAL_INTELLIGENCE'
  | 'WEB_SEARCH_RESEARCH'
  | 'PREDICTION_MARKETS'
  | 'CREATIVE'
  | 'INFRASTRUCTURE'
  | string;

/** One purchasable service, normalised from a marketplace listing. */
export interface MarketService {
  readonly url: string;
  readonly provider: string;
  readonly category: ServiceCategory;
  /** Seller-written. Untrusted, and shown to the model exactly as published. */
  readonly description: string;
  readonly tags: string[];
  readonly priceUsdc: Decimal;
  readonly chain: string;
  /** The seller's receiving address, for the mandate to be scoped against. */
  readonly payTo: string;
  readonly method: string;
  readonly supportsGateway: boolean;
}

export interface DiscoveryOptions {
  query?: string;
  category?: ServiceCategory;
  /** Ceiling in USD, applied by the API before anything reaches us. */
  maxUsdPrice?: number;
  limit?: number;
  /** Injected so tests never hit the network. */
  fetchImpl?: typeof fetch;
}

interface RawAccept {
  network?: string;
  amount?: string;
  payTo?: string;
  asset?: string;
}
interface RawListing {
  resource?: string;
  accepts?: RawAccept[];
  metadata?: {
    provider?: { name?: string; description?: string; category?: string; tags?: string[] };
    description?: string;
    method?: string;
    supportsCircleGateway?: boolean;
  };
}

/**
 * Pick the payment option we would actually use.
 *
 * Listings often carry several — the same service on Base and Polygon with
 * different receiving addresses. Preference order is testnet first (so a
 * misconfiguration spends play money), then the cheapest remaining option.
 * A seller quoting different prices per chain is choosing for us otherwise.
 */
function chooseAccept(accepts: RawAccept[]): RawAccept | undefined {
  const usable = accepts.filter((a) => a.amount && a.payTo && a.network);
  if (usable.length === 0) return undefined;
  const testnet = usable.find((a) => (CHAIN_BY_CAIP2[a.network!] ?? '').includes('sepolia')
    || (CHAIN_BY_CAIP2[a.network!] ?? '').includes('amoy'));
  if (testnet) return testnet;
  return usable.reduce((best, a) => (BigInt(a.amount!) < BigInt(best.amount!) ? a : best));
}

function normalise(raw: RawListing): MarketService | null {
  const accept = chooseAccept(raw.accepts ?? []);
  // A listing with no usable payment option cannot be bought. Three of the
  // first two hundred are like this; dropping them is not a judgement call.
  if (!accept || !raw.resource) return null;

  const provider = raw.metadata?.provider;
  return {
    url: raw.resource,
    provider: provider?.name ?? 'unknown',
    category: provider?.category ?? 'UNKNOWN',
    description: raw.metadata?.description ?? provider?.description ?? '',
    tags: provider?.tags ?? [],
    priceUsdc: Decimal.fromMicro(BigInt(accept.amount!)),
    chain: CHAIN_BY_CAIP2[accept.network!] ?? accept.network!,
    payTo: accept.payTo!,
    method: raw.metadata?.method ?? 'GET',
    supportsGateway: raw.metadata?.supportsCircleGateway === true,
  };
}

/**
 * Search the live marketplace.
 *
 * Failure returns an empty list rather than throwing: an agent that cannot
 * reach the catalogue should report that it found nothing to buy, not crash
 * mid-job. The distinction matters because "no services available" is a state
 * the agent can reason about and a stack trace is not.
 */
export async function discoverServices(
  options: DiscoveryOptions = {},
): Promise<MarketService[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const params = new URLSearchParams({ limit: String(options.limit ?? 20) });
  if (options.query) params.set('query', options.query);
  if (options.category) params.set('category', options.category);
  if (options.maxUsdPrice !== undefined) params.set('maxUsdPrice', String(options.maxUsdPrice));

  try {
    const response = await doFetch(`${DISCOVERY}?${params}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { items?: RawListing[] };
    return (body.items ?? []).map(normalise).filter((s): s is MarketService => s !== null);
  } catch {
    return [];
  }
}

/** What the model is shown. Seller text passed through untouched, by design. */
export function asListing(service: MarketService): {
  url: string;
  name: string;
  description: string;
  priceUsdc: string;
  chain: string;
} {
  return {
    url: service.url,
    name: service.provider,
    description: service.description,
    priceUsdc: service.priceUsdc.toString(),
    chain: service.chain,
  };
}
