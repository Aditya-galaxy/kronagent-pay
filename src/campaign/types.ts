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

export interface Submission {
  readonly submissionId: string;
  readonly campaignId: string;
  readonly creatorId: string;
  readonly platform: Platform;
  /** Platform-native id, used to fetch views. Creator-supplied, so untrusted. */
  readonly postId: string;
  readonly url: string;
  readonly submittedAt: string;
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
