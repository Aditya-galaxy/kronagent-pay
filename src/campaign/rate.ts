/**
 * Rate allocation — the agent's one genuine business decision, and its leash.
 *
 * As a campaign runs, the right CPM changes. Views arriving faster than the
 * pool can fund them means the rate is too high; a pool sitting untouched
 * while clippers ignore the campaign means it is too low. Deciding that is a
 * judgment about a market, which is exactly the sort of thing a model is for
 * and exactly the sort of thing no fixed rule expresses well.
 *
 * It is also a decision that moves money, so it gets the same treatment every
 * other such decision gets here: **the agent proposes, the band disposes.**
 *
 * An out-of-band proposal is *rejected*, not clamped. Clamping looks kinder
 * and is quietly worse — an agent that asks for a 50 USDC CPM against a 2 USDC
 * ceiling would receive the ceiling, which means overreach is rewarded with the
 * maximum the operator ever allowed. A model that has been talked into asking
 * for an absurd rate should get nothing, and should leave a record that it
 * asked. This mirrors how the payment engine treats an over-cap amount: it
 * refuses it, it does not quietly shrink it to fit.
 */

import { Decimal } from '../decimal';
import type { Campaign } from './types';

export type RateControl =
  | 'campaign_inactive'
  | 'below_band'
  | 'above_band'
  | 'unchanged'
  | 'within_band';

export interface RateDecision {
  readonly campaignId: string;
  readonly accepted: boolean;
  readonly control: RateControl;
  readonly fromUsdc: Decimal;
  /** What the rate is after this decision — unchanged when refused. */
  readonly toUsdc: Decimal;
  readonly proposedUsdc: Decimal;
  readonly reason: string;
  /** Verbatim, so a human reviewing an odd rate move sees the agent's case. */
  readonly rationale?: string;
  readonly decidedAt: string;
}

export interface RateProposal {
  readonly campaignId: string;
  readonly proposedUsdc: Decimal | string;
  /** The agent's argument. Recorded, never parsed, never trusted. */
  readonly rationale?: string;
}

/**
 * Judge a proposed rate against the operator's band.
 *
 * Pure and synchronous, like every other decision on this path — the verdict
 * cannot depend on anything an attacker could make slow or unavailable.
 */
export function decideRate(
  campaign: Campaign,
  proposal: RateProposal,
  now: Date = new Date(),
): RateDecision {
  const from = campaign.cpmUsdc;
  const at = now.toISOString();
  const base = {
    campaignId: campaign.campaignId,
    fromUsdc: from,
    toUsdc: from,
    rationale: proposal.rationale,
    decidedAt: at,
  };

  let proposed: Decimal;
  try {
    proposed = new Decimal(proposal.proposedUsdc);
  } catch {
    return {
      ...base,
      proposedUsdc: from,
      accepted: false,
      control: 'above_band',
      reason: 'proposed rate could not be read as an amount — the rate is unchanged',
    };
  }

  const withProposal = { ...base, proposedUsdc: proposed };

  if (campaign.status !== 'active') {
    return {
      ...withProposal,
      accepted: false,
      control: 'campaign_inactive',
      reason: `campaign is ${campaign.status}, so its rate is not up for revision`,
    };
  }

  if (proposed.micro === from.micro) {
    return {
      ...withProposal,
      accepted: false,
      control: 'unchanged',
      reason: `already at ${from} USDC/1k`,
    };
  }

  if (campaign.rateBand.minUsdc.gt(proposed)) {
    return {
      ...withProposal,
      accepted: false,
      control: 'below_band',
      reason:
        `${proposed} USDC/1k is under the ${campaign.rateBand.minUsdc} USDC floor the ` +
        'operator set — the rate is unchanged, not clamped',
    };
  }

  if (proposed.gt(campaign.rateBand.maxUsdc)) {
    return {
      ...withProposal,
      accepted: false,
      control: 'above_band',
      reason:
        `${proposed} USDC/1k is over the ${campaign.rateBand.maxUsdc} USDC ceiling the ` +
        'operator set — the rate is unchanged, not clamped, so asking for too much ' +
        'never yields the maximum',
    };
  }

  return {
    ...withProposal,
    accepted: true,
    control: 'within_band',
    toUsdc: proposed,
    reason:
      `${from} -> ${proposed} USDC/1k, inside the operator's ` +
      `${campaign.rateBand.minUsdc}–${campaign.rateBand.maxUsdc} band`,
  };
}

/**
 * Apply an accepted rate decision.
 *
 * Separate from deciding so that the decision can be recorded, shown, or
 * replayed without anything moving. A refused decision is a no-op by
 * construction rather than by the caller remembering to check.
 */
export function applyRate(campaign: Campaign, decision: RateDecision): boolean {
  if (!decision.accepted) return false;
  campaign.cpmUsdc = decision.toUsdc;
  return true;
}
