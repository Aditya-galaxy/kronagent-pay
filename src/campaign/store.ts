/**
 * Campaign state the payout gate reads.
 *
 * In-memory, like `MandateStore` and for the same reason: the decision path is
 * synchronous and side-effect free, so a verdict never waits on I/O and never
 * mutates state while deciding. Persistence lands on top of this interface
 * rather than inside it.
 *
 * The reads are separated from the writes as an interface (`CampaignView`)
 * because the gate must not be able to record anything. A gate that could
 * write its own spend total is a gate that can be made to forget it.
 */

import { Decimal } from '../decimal';
import type { Campaign, Creator, Payout, Snapshot, Submission, Verdict } from './types';

/** The narrow, read-only surface the gate depends on. */
export interface CampaignView {
  campaign(campaignId: string): Campaign | undefined;
  submission(submissionId: string): Submission | undefined;
  creator(creatorId: string): Creator | undefined;
  /** Most recent verdict, so a dispute reversal supersedes the original. */
  latestVerdict(submissionId: string): Verdict | undefined;
  snapshots(submissionId: string): readonly Snapshot[];
  /** High-water mark of views already settled for this submission. */
  viewsPaidTo(submissionId: string): bigint;
  spentOnCampaign(campaignId: string): Decimal;
  spentOnCreator(campaignId: string, creatorId: string): Decimal;
}

export class CampaignStore implements CampaignView {
  private readonly campaigns = new Map<string, Campaign>();
  private readonly submissions = new Map<string, Submission>();
  private readonly creators = new Map<string, Creator>();
  private readonly verdicts = new Map<string, Verdict[]>();
  private readonly snaps = new Map<string, Snapshot[]>();
  private readonly payouts: Payout[] = [];

  putCampaign(campaign: Campaign): void {
    this.campaigns.set(campaign.campaignId, campaign);
  }

  putSubmission(submission: Submission): void {
    this.submissions.set(submission.submissionId, submission);
  }

  /** Append-only: a re-verification supersedes rather than overwrites. */
  addVerdict(verdict: Verdict): void {
    const list = this.verdicts.get(verdict.submissionId) ?? [];
    list.push(verdict);
    this.verdicts.set(verdict.submissionId, list);
  }

  /** Append-only: comparing past against present is the whole dwell mechanic. */
  addSnapshot(snapshot: Snapshot): void {
    const list = this.snaps.get(snapshot.submissionId) ?? [];
    list.push(snapshot);
    this.snaps.set(snapshot.submissionId, list);
  }

  campaign(campaignId: string): Campaign | undefined {
    return this.campaigns.get(campaignId);
  }

  putCreator(creator: Creator): void {
    this.creators.set(creator.creatorId, creator);
  }

  submission(submissionId: string): Submission | undefined {
    return this.submissions.get(submissionId);
  }

  creator(creatorId: string): Creator | undefined {
    return this.creators.get(creatorId);
  }

  latestVerdict(submissionId: string): Verdict | undefined {
    const list = this.verdicts.get(submissionId);
    if (!list || list.length === 0) return undefined;
    let latest = list[0]!;
    for (const verdict of list) {
      if (Date.parse(verdict.at) >= Date.parse(latest.at)) latest = verdict;
    }
    return latest;
  }

  verdictHistory(submissionId: string): readonly Verdict[] {
    return this.verdicts.get(submissionId) ?? [];
  }

  snapshots(submissionId: string): readonly Snapshot[] {
    return this.snaps.get(submissionId) ?? [];
  }

  viewsPaidTo(submissionId: string): bigint {
    let high = 0n;
    for (const payout of this.payouts) {
      if (payout.submissionId !== submissionId) continue;
      if (payout.viewsPaidTo > high) high = payout.viewsPaidTo;
    }
    return high;
  }

  spentOnCampaign(campaignId: string): Decimal {
    let total = new Decimal(0n);
    for (const payout of this.payouts) {
      if (payout.campaignId === campaignId) total = total.plus(payout.amountUsdc);
    }
    return total;
  }

  spentOnCreator(campaignId: string, creatorId: string): Decimal {
    let total = new Decimal(0n);
    for (const payout of this.payouts) {
      if (payout.campaignId === campaignId && payout.creatorId === creatorId) {
        total = total.plus(payout.amountUsdc);
      }
    }
    return total;
  }

  /**
   * Record a settled payout.
   *
   * Called only after money actually moved (or would have, in dry-run). A
   * decision to hold must never advance the high-water mark, or a held payout
   * would silently cancel the views it was holding.
   */
  recordPayout(payout: Payout): void {
    this.payouts.push(payout);
  }

  payoutsFor(campaignId: string): readonly Payout[] {
    return this.payouts.filter((p) => p.campaignId === campaignId);
  }

  /** Pool minus settled spend. The number FR-T1 publishes to creators. */
  remainingPool(campaignId: string): Decimal {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return new Decimal(0n);
    const left = campaign.poolUsdc.minus(this.spentOnCampaign(campaignId));
    return left.isPositive() ? left : new Decimal(0n);
  }
}
