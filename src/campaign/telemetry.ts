/**
 * What the agent knows before it decides anything.
 *
 * Deliberately pure and deterministic, and deliberately separate from the
 * model that reasons over it. Two reasons.
 *
 * **It is testable without a network.** Every number here can be asserted
 * exactly, which is what lets the judgment layer above be tested for judgment
 * rather than for arithmetic.
 *
 * **It bounds what the model can be wrong about.** The agent cannot
 * miscalculate the burn rate or the days remaining, because it never
 * calculates them — it is handed them. Its job is the part no rule expresses:
 * *given these facts, what should the rate be, and does this pattern look
 * wrong?*
 */

import { Decimal } from '../decimal';
import type { CampaignStore } from './store';
import type { Campaign, Snapshot } from './types';

export interface CampaignTelemetry {
  readonly campaignId: string;
  readonly cpmUsdc: string;
  readonly bandUsdc: { readonly min: string; readonly max: string };
  readonly poolUsdc: string;
  readonly spentUsdc: string;
  readonly remainingUsdc: string;
  /** 0–1. How much of the pool is gone. */
  readonly poolUsedFraction: number;
  /** 0–1. How far through the campaign's calendar we are. */
  readonly timeElapsedFraction: number;
  readonly hoursRemaining: number;
  readonly submissions: number;
  readonly paidSubmissions: number;
  readonly heldSubmissions: number;
  readonly confirmedViews: string;
  /**
   * Spend per hour so far. The number that says whether the pool lasts.
   */
  readonly burnUsdcPerHour: string;
  /**
   * Hours until the pool empties at the current rate, or null if nothing is
   * being spent. Null is meaningful: it means the campaign is not moving.
   */
  readonly hoursToExhaustion: number | null;
}

/** Everything the rate decision needs, computed rather than guessed. */
export function campaignTelemetry(
  store: CampaignStore,
  campaign: Campaign,
  now: Date = new Date(),
): CampaignTelemetry {
  const spent = store.spentOnCampaign(campaign.campaignId);
  const remaining = store.remainingPool(campaign.campaignId);
  const submissions = store
    .exportState()
    .submissions.filter((s) => s.campaignId === campaign.campaignId);

  const startMs = Date.parse(campaign.startsAt);
  const endMs = Date.parse(campaign.endsAt);
  const nowMs = now.getTime();
  const totalMs = Math.max(endMs - startMs, 1);
  const elapsedMs = Math.max(nowMs - startMs, 0);

  const elapsedHours = elapsedMs / 3_600_000;
  // Guard the divisor: a campaign seconds old would otherwise report an
  // enormous burn rate from its first payout and panic the agent into cutting
  // the rate on no evidence.
  const burnPerHour =
    elapsedHours >= 1
      ? Decimal.fromMicro(spent.micro / BigInt(Math.floor(elapsedHours)))
      : new Decimal(0n);

  const paid = submissions.filter((s) => store.viewsPaidTo(s.submissionId) > 0n).length;
  let confirmed = 0n;
  for (const s of submissions) confirmed += store.viewsPaidTo(s.submissionId);

  return {
    campaignId: campaign.campaignId,
    cpmUsdc: campaign.cpmUsdc.toString(),
    bandUsdc: { min: campaign.rateBand.minUsdc.toString(), max: campaign.rateBand.maxUsdc.toString() },
    poolUsdc: campaign.poolUsdc.toString(),
    spentUsdc: spent.toString(),
    remainingUsdc: remaining.toString(),
    poolUsedFraction:
      campaign.poolUsdc.micro > 0n ? Number(spent.micro) / Number(campaign.poolUsdc.micro) : 0,
    timeElapsedFraction: Math.min(elapsedMs / totalMs, 1),
    hoursRemaining: Math.max((endMs - nowMs) / 3_600_000, 0),
    submissions: submissions.length,
    paidSubmissions: paid,
    heldSubmissions: submissions.length - paid,
    confirmedViews: confirmed.toString(),
    burnUsdcPerHour: burnPerHour.toString(),
    hoursToExhaustion:
      burnPerHour.micro > 0n ? Number(remaining.micro) / Number(burnPerHour.micro) : null,
  };
}

export interface VelocitySignal {
  readonly submissionId: string;
  readonly samples: number;
  readonly latestViews: string;
  /** Largest single-interval jump, in views per hour. */
  readonly peakViewsPerHour: number;
  /** Typical rate across the whole window. */
  readonly meanViewsPerHour: number;
  /**
   * `peak / mean`. A clip growing steadily sits near 1; one that took a
   * sudden vertical jump sits far above it. Not proof of anything — a video
   * genuinely going viral looks identical — which is exactly why the decision
   * is not a threshold.
   */
  readonly burstRatio: number;
  /** Whether the count ever fell, i.e. the platform removed views. */
  readonly everFell: boolean;
  readonly largestDrop: string;
}

/**
 * How a clip's views moved, as numbers rather than a verdict.
 *
 * This deliberately does not decide anything. Bot inflation and genuine virality
 * produce the same shape, and a threshold here would either miss the first or
 * punish the second. The numbers go to something that can weigh them in
 * context — and, critically, whose worst case is a *delay*.
 */
export function viewVelocity(
  submissionId: string,
  snapshots: readonly Snapshot[],
): VelocitySignal | null {
  const ordered = [...snapshots]
    .filter((s) => !Number.isNaN(Date.parse(s.fetchedAt)))
    .sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt));
  if (ordered.length < 2) return null;

  let peak = 0;
  let everFell = false;
  let largestDrop = 0n;

  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const curr = ordered[i]!;
    const hours = (Date.parse(curr.fetchedAt) - Date.parse(prev.fetchedAt)) / 3_600_000;
    if (hours <= 0) continue;
    const delta = curr.views - prev.views;
    if (delta < 0n) {
      everFell = true;
      if (-delta > largestDrop) largestDrop = -delta;
      continue;
    }
    const rate = Number(delta) / hours;
    if (rate > peak) peak = rate;
  }

  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const spanHours = (Date.parse(last.fetchedAt) - Date.parse(first.fetchedAt)) / 3_600_000;
  const mean = spanHours > 0 ? Number(last.views - first.views) / spanHours : 0;

  return {
    submissionId,
    samples: ordered.length,
    latestViews: last.views.toString(),
    peakViewsPerHour: peak,
    meanViewsPerHour: mean,
    burstRatio: mean > 0 ? peak / mean : peak > 0 ? Infinity : 1,
    everFell,
    largestDrop: largestDrop.toString(),
  };
}
