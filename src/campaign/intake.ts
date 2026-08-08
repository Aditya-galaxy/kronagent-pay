/**
 * How campaigns get opened and clips get submitted.
 *
 * Until this existed the repo was an engine, not a platform: every invariant
 * held, and the only way to exercise them was to write TypeScript. These are
 * the two doors — one for the brand funding a campaign, one for the creator
 * submitting work.
 *
 * The asymmetry between them is deliberate.
 *
 * **Opening a campaign is operator-gated.** It declares a pool, and a pool is
 * a promise to pay. Anyone who can create one can commit the operator's money.
 *
 * **Submitting a clip is public.** A creator has no account here and shouldn't
 * need one — the payout address *is* the identity, because it is the thing
 * that receives money. Requiring a signup before someone can be paid is the
 * friction this whole product exists to remove.
 *
 * Validation happens here rather than at the gate, because a refusal is only
 * kind if it arrives *before* the creator does the work. The gate's refusals
 * are for things we could not know in advance.
 */

import { Decimal } from '../decimal';
import { parsePostUrl } from './postref';
import { acceptSubmission, DEFAULT_SETTLEMENT_WINDOW_MS } from './terms';
import type { Campaign, Creator, Platform, Submission } from './types';

/** An EVM address, which is all a creator needs to be paid. */
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export interface OpenCampaignInput {
  campaignId?: string;
  brief?: unknown;
  poolUsdc?: unknown;
  cpmUsdc?: unknown;
  perCreatorCapUsdc?: unknown;
  minCpmUsdc?: unknown;
  maxCpmUsdc?: unknown;
  dwellHours?: unknown;
  settlementDays?: unknown;
  platforms?: unknown;
  chain?: unknown;
  endsAt?: unknown;
}

export type Refusal = { ok: false; error: string; field?: string };
export type Accepted<T> = { ok: true; value: T };
export type Result<T> = Accepted<T> | Refusal;

const bad = (error: string, field?: string): Refusal => ({ ok: false, error, field });

/** Parse a USDC amount, refusing anything `Decimal` cannot represent exactly. */
function amount(raw: unknown, field: string): Result<Decimal> {
  if (raw === undefined || raw === null || raw === '') return bad(`${field} is required`, field);
  try {
    const value = new Decimal(String(raw));
    if (value.micro < 0n) return bad(`${field} cannot be negative`, field);
    return { ok: true, value };
  } catch (error) {
    // Decimal refuses >6dp rather than rounding someone's money. Say why.
    return bad(`${field}: ${(error as Error).message}`, field);
  }
}

const CHAINS = new Set(['base', 'base-sepolia', 'ethereum', 'eth-sepolia', 'polygon', 'polygon-amoy']);
const PLATFORMS = new Set<Platform>(['youtube', 'x']);

export function openCampaign(
  input: OpenCampaignInput,
  now: Date = new Date(),
): Result<Campaign> {
  const brief = typeof input.brief === 'string' ? input.brief.trim() : '';
  if (brief.length < 10) {
    return bad('brief must be at least 10 characters — it is what the agent judges against', 'brief');
  }

  const pool = amount(input.poolUsdc, 'poolUsdc');
  if (!pool.ok) return pool;
  if (!pool.value.isPositive()) return bad('poolUsdc must be greater than zero', 'poolUsdc');

  const cpm = amount(input.cpmUsdc, 'cpmUsdc');
  if (!cpm.ok) return cpm;
  const perCreator = amount(input.perCreatorCapUsdc ?? pool.value.toString(), 'perCreatorCapUsdc');
  if (!perCreator.ok) return perCreator;
  const minCpm = amount(input.minCpmUsdc ?? cpm.value.toString(), 'minCpmUsdc');
  if (!minCpm.ok) return minCpm;
  const maxCpm = amount(input.maxCpmUsdc ?? cpm.value.toString(), 'maxCpmUsdc');
  if (!maxCpm.ok) return maxCpm;

  if (minCpm.value.gt(maxCpm.value)) {
    return bad('minCpmUsdc cannot exceed maxCpmUsdc', 'minCpmUsdc');
  }
  if (minCpm.value.gt(cpm.value) || cpm.value.gt(maxCpm.value)) {
    return bad('cpmUsdc must sit inside the rate band', 'cpmUsdc');
  }
  if (perCreator.value.gt(pool.value)) {
    // Not fatal in the engine, but it means the cap can never bind, which is
    // almost always a typo rather than an intention.
    return bad('perCreatorCapUsdc cannot exceed the pool', 'perCreatorCapUsdc');
  }

  const chain = typeof input.chain === 'string' ? input.chain : 'base-sepolia';
  if (!CHAINS.has(chain)) {
    return bad(`chain must be one of ${[...CHAINS].join(', ')}`, 'chain');
  }

  const platforms = Array.isArray(input.platforms) && input.platforms.length > 0
    ? (input.platforms as Platform[])
    : (['youtube'] as Platform[]);
  for (const p of platforms) {
    if (!PLATFORMS.has(p)) {
      return bad(
        `platform "${p}" is not verifiable — YouTube and X only. Instagram, ` +
          'Facebook and TikTok need platform app review we do not hold.',
        'platforms',
      );
    }
  }

  const dwellHours = Number(input.dwellHours ?? 24);
  if (!Number.isFinite(dwellHours) || dwellHours < 0 || dwellHours > 168) {
    return bad('dwellHours must be between 0 and 168', 'dwellHours');
  }

  const settlementDays = Number(input.settlementDays ?? 14);
  if (!Number.isFinite(settlementDays) || settlementDays <= 0) {
    return bad('settlementDays must be positive', 'settlementDays');
  }
  const settlementWindowMs = settlementDays * 86_400_000;
  if (settlementWindowMs <= dwellHours * 3_600_000) {
    // Otherwise the obligation expires before the views can even confirm, and
    // the guarantee to the creator is theatre.
    return bad(
      'settlementDays must outlast dwellHours, or a clip can expire before its ' +
        'views have had time to confirm',
      'settlementDays',
    );
  }

  const endsAt = typeof input.endsAt === 'string' ? input.endsAt : undefined;
  const endsAtMs = endsAt ? Date.parse(endsAt) : now.getTime() + 30 * 86_400_000;
  if (Number.isNaN(endsAtMs)) return bad('endsAt is not a valid date', 'endsAt');
  if (endsAtMs <= now.getTime()) return bad('endsAt must be in the future', 'endsAt');

  return {
    ok: true,
    value: {
      campaignId: (input.campaignId ?? `camp-${crypto.randomUUID().slice(0, 8)}`).trim(),
      brief,
      poolUsdc: pool.value,
      cpmUsdc: cpm.value,
      rateBand: { minUsdc: minCpm.value, maxUsdc: maxCpm.value },
      perCreatorCapUsdc: perCreator.value,
      dwellMs: dwellHours * 3_600_000,
      settlementWindowMs: settlementWindowMs || DEFAULT_SETTLEMENT_WINDOW_MS,
      platforms,
      chain: chain as Campaign['chain'],
      status: 'active',
      startsAt: now.toISOString(),
      endsAt: new Date(endsAtMs).toISOString(),
    },
  };
}

export interface SubmitInput {
  campaignId?: unknown;
  url?: unknown;
  payoutAddress?: unknown;
  handle?: unknown;
}

/**
 * Take a clip in.
 *
 * Everything that can be refused is refused *here*, before the creator has
 * done anything on the strength of it. The one thing this cannot check is
 * whether the clip meets the brief — that needs the video, and it happens
 * after acceptance under terms already frozen.
 */
export function submitClip(
  campaign: Campaign | undefined,
  input: SubmitInput,
  now: Date = new Date(),
): Result<{ submission: Submission; creator: Creator }> {
  if (!campaign) return bad('unknown campaignId', 'campaignId');

  const address = typeof input.payoutAddress === 'string' ? input.payoutAddress.trim() : '';
  if (!ADDRESS.test(address)) {
    return bad('payoutAddress must be a 0x-prefixed 40-character address', 'payoutAddress');
  }

  const ref = parsePostUrl(typeof input.url === 'string' ? input.url : '');
  if (!ref) {
    return bad(
      'url must be a YouTube or X post. Instagram, Facebook and TikTok cannot ' +
        'be verified, and accepting the link would promise a check we cannot perform.',
      'url',
    );
  }
  if (!campaign.platforms.includes(ref.platform)) {
    return bad(`this campaign pays on ${campaign.platforms.join(', ')} only`, 'url');
  }

  // The wallet is the identity. A creator who has never been here before is
  // simply a wallet we have not paid yet.
  const creatorId = `cre-${address.toLowerCase()}`;
  const handle = typeof input.handle === 'string' ? input.handle.trim().slice(0, 64) : undefined;

  const accepted = acceptSubmission(
    campaign,
    {
      submissionId: `sub-${ref.platform}-${ref.postId}-${creatorId.slice(4, 14)}`,
      creatorId,
      platform: ref.platform,
      postId: ref.postId,
      url: typeof input.url === 'string' ? input.url : '',
    },
    now,
  );
  if (!accepted.accepted) return bad(accepted.detail, 'campaignId');

  return {
    ok: true,
    value: {
      submission: accepted.submission,
      creator: {
        creatorId,
        payoutAddress: address,
        handles: handle ? { [ref.platform]: handle } : {},
      },
    },
  };
}
