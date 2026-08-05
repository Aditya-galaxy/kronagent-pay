/**
 * What counts as a view worth paying for, and what that view is worth.
 *
 * This file is the anti-fraud mechanic, and it is deliberately **not fraud
 * detection**. We do not try to identify a bot ring — a platform with a fraud
 * team and full telemetry is better placed to do that than we are, and every
 * public account of this problem is a story about someone losing that arms
 * race. We change what is being bought instead.
 *
 * **A view is payable once it has survived.** Take the count now, take the
 * count from at least `dwellMs` ago, and pay against the smaller of the two:
 *
 *   - views still climbing  -> the older, smaller number wins, so nothing is
 *     paid for until it has had time to stick
 *   - views scrubbed by the platform between snapshots -> the newer, smaller
 *     number wins, so inflation that got removed is never paid for
 *
 * The asymmetry is the point. Inflating a count costs an attacker nothing;
 * keeping it inflated through the platform's own retro-scrubbing for a full day
 * is a materially harder problem, and it is the platform's fraud team doing
 * that work rather than ours. Whop arrived at a 24h payout delay empirically
 * after a botting scandal; this is the same delay derived from what it is
 * actually for.
 *
 * The corollary, made explicit because it is a design decision and not an
 * oversight: **there is no clawback.** Falling views reduce the *next* payout,
 * possibly to nothing, but never produce a negative one. Money that has
 * settled on-chain cannot be recalled, so a system that pretends otherwise is
 * lying about its own guarantees.
 */

import { Decimal } from '../decimal';
import type { Snapshot } from './types';

const PER_MILLE = 1_000n;

/**
 * Views that have both appeared and persisted, as of `now`.
 *
 * Returns 0 when nothing has aged past the dwell period yet — a brand-new
 * submission is worth nothing until its views have had time to stand up, which
 * is the fail-closed direction.
 */
export function confirmedViews(
  snapshots: readonly Snapshot[],
  options: { dwellMs: number; now?: Date },
): bigint {
  const nowMs = (options.now ?? new Date()).getTime();
  const cutoff = nowMs - options.dwellMs;

  let latest: Snapshot | undefined;
  let latestAged: Snapshot | undefined;

  for (const snapshot of snapshots) {
    const atMs = Date.parse(snapshot.fetchedAt);
    // An unparseable timestamp cannot be placed on either side of the dwell
    // window, and guessing would let a malformed record authorize a payout.
    if (Number.isNaN(atMs)) continue;
    if (!latest || atMs > Date.parse(latest.fetchedAt)) latest = snapshot;
    if (atMs <= cutoff) {
      if (!latestAged || atMs > Date.parse(latestAged.fetchedAt)) latestAged = snapshot;
    }
  }

  if (!latest || !latestAged) return 0n;
  // The smaller of "how many there are" and "how many had time to settle".
  return latestAged.views < latest.views ? latestAged.views : latest.views;
}

/**
 * Whether any snapshot is old enough to anchor a confirmation.
 *
 * Distinct from `confirmedViews() === 0n`, and the distinction is what a
 * creator is told: "your clip has not had time to settle yet, come back" is a
 * different message from "your clip has no views", and conflating them reads
 * as a rejection when it is a wait.
 */
export function hasDwelled(
  snapshots: readonly Snapshot[],
  options: { dwellMs: number; now?: Date },
): boolean {
  const cutoff = (options.now ?? new Date()).getTime() - options.dwellMs;
  return snapshots.some((s) => {
    const atMs = Date.parse(s.fetchedAt);
    return !Number.isNaN(atMs) && atMs <= cutoff;
  });
}

/**
 * What a block of views earns at a given rate.
 *
 * Integer division truncates, so a partial thousand rounds *down*. That
 * underpays by less than one micro-USDC and it underpays in the direction that
 * cannot overspend a pool, which is the only rounding direction a payment
 * system gets to pick without an argument.
 */
export function earningsFor(views: bigint, cpmUsdc: Decimal): Decimal {
  if (views <= 0n) return new Decimal(0n);
  return Decimal.fromMicro((views * cpmUsdc.micro) / PER_MILLE);
}

/**
 * Views not yet paid for.
 *
 * Deliberately computed against a high-water mark rather than by re-deriving
 * the whole amount: if the operator's agent moves the CPM mid-campaign, new
 * views earn the new rate and already-settled views are not retroactively
 * repriced. Recomputing a total at the current rate would do exactly that, and
 * would either claw back or double-pay depending on which way the rate moved.
 */
export function payableViews(confirmed: bigint, viewsPaidTo: bigint): bigint {
  const delta = confirmed - viewsPaidTo;
  return delta > 0n ? delta : 0n;
}
