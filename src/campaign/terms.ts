/**
 * Accepting a clip into a campaign, and freezing the deal when we do.
 *
 * The only supported way to build a `Submission`, because the terms are what
 * make the arrangement bilateral and a constructor that could omit them would
 * be a constructor someone eventually omits them from.
 *
 * Acceptance is also the one place where campaign status legitimately blocks a
 * creator: a paused or ended campaign takes no *new* work. What it may not do
 * is abandon work it already took, and that distinction is the whole point —
 * `payout.ts` stops consulting the live campaign once a clip is accepted.
 */

import { Decimal } from '../decimal';
import type { Campaign, CampaignTerms, Platform, Submission } from './types';

/** 14 days. Long enough that a 24h dwell plus a slow week still settles. */
export const DEFAULT_SETTLEMENT_WINDOW_MS = 14 * 86_400_000;

export function termsFor(campaign: Campaign, now: Date = new Date()): CampaignTerms {
  const window = campaign.settlementWindowMs || DEFAULT_SETTLEMENT_WINDOW_MS;
  return {
    cpmUsdc: new Decimal(campaign.cpmUsdc),
    dwellMs: campaign.dwellMs,
    perCreatorCapUsdc: new Decimal(campaign.perCreatorCapUsdc),
    acceptedAt: now.toISOString(),
    settlementDeadline: new Date(now.getTime() + window).toISOString(),
  };
}

export interface AcceptSubmissionInput {
  submissionId: string;
  creatorId: string;
  platform: Platform;
  postId: string;
  url: string;
}

export type AcceptRefusal =
  | 'campaign_not_active'
  | 'campaign_window_closed'
  | 'platform_not_allowed';

export type AcceptResult =
  | { accepted: true; submission: Submission }
  | { accepted: false; reason: AcceptRefusal; detail: string };

/**
 * Take a clip into a campaign under the terms standing right now.
 *
 * Refusing here is cheap and honest — the creator has not done the work yet.
 * Refusing *after* they have is the failure this whole file exists to prevent.
 */
export function acceptSubmission(
  campaign: Campaign,
  input: AcceptSubmissionInput,
  now: Date = new Date(),
): AcceptResult {
  if (campaign.status !== 'active') {
    return {
      accepted: false,
      reason: 'campaign_not_active',
      detail: `campaign ${campaign.campaignId} is ${campaign.status} and is taking no new clips`,
    };
  }

  const nowMs = now.getTime();
  if (nowMs < Date.parse(campaign.startsAt) || nowMs >= Date.parse(campaign.endsAt)) {
    return {
      accepted: false,
      reason: 'campaign_window_closed',
      detail:
        `campaign runs ${campaign.startsAt} to ${campaign.endsAt} — ` +
        'told before you post, rather than after',
    };
  }

  if (!campaign.platforms.includes(input.platform)) {
    return {
      accepted: false,
      reason: 'platform_not_allowed',
      detail:
        `this campaign pays on ${campaign.platforms.join(', ')} — ` +
        `${input.platform} views cannot be verified for it`,
    };
  }

  return {
    accepted: true,
    submission: {
      submissionId: input.submissionId,
      campaignId: campaign.campaignId,
      creatorId: input.creatorId,
      platform: input.platform,
      postId: input.postId,
      url: input.url,
      submittedAt: now.toISOString(),
      acceptedTerms: termsFor(campaign, now),
    },
  };
}

/** True once the brand is no longer bound to settle this clip. */
export function termsExpired(terms: CampaignTerms, now: Date = new Date()): boolean {
  const deadline = Date.parse(terms.settlementDeadline);
  // A corrupt deadline must not read as "bound forever" — but nor should it
  // read as expired, which would strip a creator of a payout on a typo. The
  // safe reading is the one that still owes them: unparseable means live, and
  // the pool cap still bounds the damage.
  if (Number.isNaN(deadline)) return false;
  return now.getTime() >= deadline;
}
