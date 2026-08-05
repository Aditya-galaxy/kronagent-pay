/**
 * A creator campaign, and everything the payout path reads.
 *
 * The shape mirrors the split that already governs payments: what an *agent*
 * produces is untrusted evidence, and what the *engine* produces is the only
 * thing that moves money. A `Verdict` is the agent's judgment about a clip and
 * carries no authority; a `Snapshot` is a fact retrieved from a platform API,
 * never from the creator; a `Payout` exists only downstream of a deterministic
 * decision.
 *
 * The one field worth pausing on is `dwellMs`. Views are not paid for when
 * they appear — they are paid for when they have *survived*. See `views.ts`.
 */

import type { Decimal } from '../decimal';
import type { Chain } from '../schemas';

/** Where a clip was posted. Only these two can be verified without app review. */
export type Platform = 'youtube' | 'x';

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'ended';

export interface Campaign {
  readonly campaignId: string;
  /** Natural language, written by the operator. What the agent judges against. */
  readonly brief: string;
  /** Total the campaign may ever disburse. A hard ceiling, never raised by the agent. */
  readonly poolUsdc: Decimal;
  /** USDC per 1,000 confirmed views. Movable by the agent, but only within `rateBand`. */
  cpmUsdc: Decimal;
  /**
   * The floor and ceiling the agent's rate decisions must stay inside. The
   * agent may allocate; it may not rewrite its own budget.
   */
  readonly rateBand: { readonly minUsdc: Decimal; readonly maxUsdc: Decimal };
  /** Most one creator may earn from this campaign. Bounds a single-account attack. */
  readonly perCreatorCapUsdc: Decimal;
  /** How long a view must persist before it is payable. 24h default. */
  readonly dwellMs: number;
  /**
   * How long after accepting a clip the brand stays bound to settle it.
   *
   * The window has to outlast `dwellMs` by a wide margin or the guarantee is
   * theatre: a creator whose views are still settling when the campaign ends
   * is exactly the person this protects.
   */
  readonly settlementWindowMs: number;
  readonly platforms: readonly Platform[];
  readonly chain: Chain;
  status: CampaignStatus;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface Creator {
  readonly creatorId: string;
  /** Where USDC is sent. The payout's counterparty, and what a mandate scopes. */
  readonly payoutAddress: string;
  readonly handles: Readonly<Partial<Record<Platform, string>>>;
}

/**
 * The deal, frozen at the moment a clip was accepted.
 *
 * Everything else in this system protects the brand from the agent — pool
 * caps, rate bands, mandates, the kill switch. This is the only thing that
 * protects the creator from the brand, and it exists because without it the
 * system reproduces the exact complaint it was built to answer: *"joining a
 * hot campaign, generating genuine views, and never being paid."*
 *
 * A live campaign is a policy: one party sets it, one party is bound by it. A
 * brand could halve the CPM, lengthen the dwell, or pause outright while a
 * creator's clip was still settling, and the creator would have no recourse
 * for work already done in good faith. Copying the terms onto the submission
 * makes it an *agreement* — the clip settles under the deal it was accepted
 * under, whatever the campaign does afterwards.
 *
 * What this cannot do is conjure money. If the pool empties, it empties; that
 * is disclosed rather than papered over, and it is why the remaining pool is
 * published before a creator invests any effort.
 */
export interface CampaignTerms {
  readonly cpmUsdc: Decimal;
  readonly dwellMs: number;
  readonly perCreatorCapUsdc: Decimal;
  readonly acceptedAt: string;
  /** After this, the brand is no longer bound and the clip stops settling. */
  readonly settlementDeadline: string;
}

export interface Submission {
  readonly submissionId: string;
  readonly campaignId: string;
  readonly creatorId: string;
  readonly platform: Platform;
  /** Platform-native id, used to fetch views. Creator-supplied, so untrusted. */
  readonly postId: string;
  readonly url: string;
  readonly submittedAt: string;
  /**
   * Required, not optional. An optional field here would let a caller forget
   * it and silently fall back to the live campaign, which is the hole this
   * closes. Build submissions with `acceptSubmission`.
   */
  readonly acceptedTerms: CampaignTerms;
}

/**
 * The agent's judgment on whether a clip satisfies the brief.
 *
 * Advisory by construction. There is no field here the gate reads as
 * permission, and no confidence value that shortcuts a limit — `pass` is a
 * precondition for payment, never a cause of it. A model that has been talked
 * into returning `pass` has bought the creator a *chance* at a payout that
 * every other control still has to agree to.
 */
export interface Verdict {
  readonly verdictId: string;
  readonly submissionId: string;
  readonly pass: boolean;
  /** Written for the creator who was rejected, not for a log parser. */
  readonly reasons: readonly string[];
  readonly confidence: number;
  readonly model: string;
  readonly at: string;
  /** Set when this verdict supersedes an earlier one after a dispute. */
  readonly supersedes?: string;
}

/**
 * A view count as retrieved from a platform API at a point in time.
 *
 * Immutable and append-only: the whole anti-fraud mechanic depends on being
 * able to compare what a post claimed then against what it claims now, so a
 * snapshot is never updated in place.
 */
export interface Snapshot {
  readonly submissionId: string;
  readonly views: bigint;
  readonly fetchedAt: string;
  readonly source: Platform;
}

export interface Payout {
  readonly payoutId: string;
  readonly submissionId: string;
  readonly campaignId: string;
  readonly creatorId: string;
  /** Views this payout covered — the high-water mark, which never decreases. */
  readonly viewsPaidTo: bigint;
  readonly amountUsdc: Decimal;
  readonly at: string;
  readonly txHash?: string;
  readonly explorerUrl?: string;
}
