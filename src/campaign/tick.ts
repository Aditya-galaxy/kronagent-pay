/**
 * One pass of the campaign agent.
 *
 * Deliberately shaped as a single idempotent function rather than an
 * in-process timer, because on Cloud Run the cheap and observable way to run
 * recurring work is Cloud Scheduler hitting an endpoint. Every tick then
 * arrives as an HTTP request, which means Cloud Logging records each agent run
 * for free — and "agent execution logs" is a thing the competition asks for,
 * so getting them as a side effect of the deployment shape beats building
 * them.
 *
 * The ordering rules here are the ones that matter:
 *
 * **Views are refreshed before deciding**, never after, so a decision is made
 * against the freshest count the oracle could give us.
 *
 * **A payout is recorded only after settlement succeeds.** Recording first
 * would advance the high-water mark for money that never moved, and the next
 * tick would treat those views as already paid. The creator would simply never
 * be paid for them, silently.
 *
 * **Each fact is appended to the log as it becomes true**, not batched at the
 * end of the tick. The log is one object per event with a create-only
 * precondition, so two concurrent passes cannot overwrite each other and a
 * retry after a crash writes the same key and is refused. The event id for a
 * payout is the same `pay-<submission>-<views>` the executor passes as
 * `--idempotency-key`, so both sides of the boundary dedupe on the same
 * value.
 *
 * **One submission's failure never aborts the tick.** An oracle timing out on
 * a single clip must not stop every other creator getting paid. It also must
 * not cause a payout: a missing view count leaves the last snapshot standing,
 * and the gate decides on that.
 */

import { Decimal } from '../decimal';
import type { PaymentOutcome } from '../schemas';
import type { PayoutDecision, PayoutGate } from './payout';
import type { EventLog } from './eventlog';
import type { FraudInvestigator, RateProposer } from './agent';
import { proposeRateFor } from './agent';
import { applyRate } from './rate';
import { campaignTelemetry, viewVelocity } from './telemetry';
import type { CampaignStore } from './store';
import type { Campaign, Creator, Submission } from './types';

/** Retrieves a view count from the platform. Never from the creator. */
export interface ViewOracle {
  /** `undefined` means "could not tell", which is not the same as zero. */
  fetch(submission: Submission): Promise<bigint | undefined>;
}

/** Moves the USDC. Injected so a tick can run fully dry. */
export interface PayoutExecutor {
  send(input: {
    decision: PayoutDecision;
    creator: Creator;
    campaign: Campaign;
  }): Promise<PaymentOutcome>;
}

/** Records what happened, including what did not. */
export interface DecisionSink {
  record(decision: PayoutDecision, outcome?: PaymentOutcome): void;
}

export interface TickDeps {
  store: CampaignStore;
  gate: PayoutGate;
  oracle: ViewOracle;
  executor: PayoutExecutor;
  log?: EventLog;
  sink?: DecisionSink;
  /** Judgment, both halves optional. Absent means the pass is purely mechanical. */
  agent?: { rate?: RateProposer; investigator?: FraudInvestigator };
}

export interface TickResult {
  readonly startedAt: string;
  /** What the agent proposed and whether the band allowed it. */
  readonly rateChanges: readonly string[];
  /** Payouts the investigator delayed. Never payouts it caused. */
  readonly investigationsHeld: readonly string[];
  readonly campaigns: number;
  readonly submissions: number;
  readonly paid: number;
  readonly held: number;
  readonly blocked: number;
  readonly needsApproval: number;
  readonly totalPaidUsdc: Decimal;
  readonly decisions: readonly PayoutDecision[];
  /** Per-submission failures, so one bad clip is visible without hiding the rest. */
  readonly errors: readonly string[];
}

export async function runTick(
  deps: TickDeps,
  options: { agentId: string; now?: Date } = { agentId: 'campaign-agent' },
): Promise<TickResult> {
  const now = options.now ?? new Date();
  const { store, gate, oracle, executor, log, sink, agent } = deps;

  const decisions: PayoutDecision[] = [];
  const errors: string[] = [];
  const rateChanges: string[] = [];
  const investigationsHeld: string[] = [];
  let paid = 0;
  let held = 0;
  let blocked = 0;
  let needsApproval = 0;
  let total = new Decimal(0n);
  let submissionCount = 0;

  // Not `status === 'active'`. A paused or ended campaign still owes on clips
  // it already accepted, and skipping it here would honour the terms in the
  // gate while never asking the gate — the guarantee would hold in a unit test
  // and quietly fail in production. Only a draft has nothing to settle, and
  // `terms_expired` is what actually ends the obligation.
  const campaigns = store.exportState().campaigns.filter((c) => c.status !== 'draft');
  const submissions = store.exportState().submissions;

  for (const campaign of campaigns) {
    // Once per campaign: the agent may move the rate inside the operator's
    // band. Applied before this pass decides anything, so a change takes
    // effect on clips accepted afterwards — never on work already accepted,
    // whose terms are frozen.
    if (agent?.rate) {
      try {
        const decision = await proposeRateFor(
          campaign, campaignTelemetry(store, campaign, now), agent.rate, now,
        );
        if (applyRate(campaign, decision)) {
          await log?.append({ type: 'campaign_upserted', campaign }, now);
          rateChanges.push(`${campaign.campaignId}: ${decision.reason}`);
        } else if (decision.control !== 'unchanged') {
          // A refused proposal is the interesting one — it is evidence about
          // the agent, so it is recorded rather than dropped.
          rateChanges.push(`${campaign.campaignId}: REFUSED — ${decision.reason}`);
        }
      } catch (error) {
        errors.push(`${campaign.campaignId}: rate proposal failed — ${(error as Error).message}`);
      }
    }

    for (const submission of submissions) {
      if (submission.campaignId !== campaign.campaignId) continue;
      submissionCount += 1;

      try {
        const views = await oracle.fetch(submission);
        if (views !== undefined) {
          const snapshot = {
            submissionId: submission.submissionId,
            views,
            fetchedAt: now.toISOString(),
            source: submission.platform,
          };
          // Durable first, in-memory second. A snapshot only this process knows
          // about is a dwell window that dies with the instance.
          await log?.append({ type: 'snapshot_taken', snapshot }, now);
          store.addSnapshot(snapshot);
        }

        const decision = gate.decide(submission.submissionId, { agentId: options.agentId, now });
        decisions.push(decision);

        if (decision.disposition !== 'auto_pay') {
          if (decision.disposition === 'held') held += 1;
          else if (decision.disposition === 'blocked') blocked += 1;
          else if (decision.disposition === 'requires_approval') needsApproval += 1;
          sink?.record(decision);
          continue;
        }

        // The investigator runs only on clips about to be paid, and only when
        // there is enough history to show a trend. Its strongest outcome is a
        // delay: there is no finding here that releases money.
        if (agent?.investigator) {
          const signal = viewVelocity(submission.submissionId, store.snapshots(submission.submissionId));
          if (signal && (signal.everFell || signal.burstRatio > 5)) {
            try {
              const found = await agent.investigator.investigate(signal, {
                dwellHours: Math.round(submission.acceptedTerms.dwellMs / 3_600_000),
              });
              if (found.finding === 'hold') {
                investigationsHeld.push(
                  `${submission.submissionId}: ${found.reasons.join('; ') || 'held by investigation'}`,
                );
                held += 1;
                continue;
              }
            } catch (error) {
              // A failed investigation must not block an honest creator. The
              // deterministic controls already ran and said pay.
              errors.push(`${submission.submissionId}: investigation failed — ${(error as Error).message}`);
            }
          }
        }

        const creator = store.creator(submission.creatorId);
        if (!creator) {
          errors.push(`${submission.submissionId}: creator vanished between decision and payment`);
          continue;
        }

        const outcome = await executor.send({ decision, creator, campaign });
        sink?.record(decision, outcome);

        // Only now. A recorded payout for money that never moved would mark
        // these views settled forever.
        if (!outcome.executed) {
          errors.push(`${submission.submissionId}: settlement failed — ${outcome.error ?? outcome.detail}`);
          continue;
        }

        const settled = {
          // Same id the executor passed as --idempotency-key, so a retry after
          // a crash writes to the same key and is refused rather than doubled.
          payoutId: `pay-${submission.submissionId}-${decision.confirmedViews}`,
          submissionId: submission.submissionId,
          campaignId: campaign.campaignId,
          creatorId: creator.creatorId,
          viewsPaidTo: decision.confirmedViews,
          amountUsdc: decision.amountUsdc,
          at: now.toISOString(),
          txHash: outcome.txHash,
          explorerUrl: outcome.explorerUrl,
        };
        // The append's return value is the authority on whether *this* pass is
        // the one that recorded the payout. Ignoring it double-counts spend
        // against the pool whenever two passes overlap: the log correctly
        // refuses the duplicate, and the store then records it anyway.
        //
        // That breaches I12 for the life of the process, and it is invisible
        // — replaying the log afterwards produces the right total, so the
        // corruption exists only in the instance actually making decisions.
        const written = log
          ? await log.append({ type: 'payout_settled', payout: settled }, now)
          : true;
        if (!written) {
          errors.push(
            `${submission.submissionId}: already settled by a concurrent pass — not counted again`,
          );
          continue;
        }
        store.recordPayout(settled);
        paid += 1;
        total = total.plus(decision.amountUsdc);
      } catch (error) {
        // One clip's oracle timing out must not stop everyone else being paid.
        errors.push(`${submission.submissionId}: ${(error as Error).message}`);
      }
    }
  }

  return {
    startedAt: now.toISOString(),
    campaigns: campaigns.length,
    submissions: submissionCount,
    paid,
    held,
    blocked,
    needsApproval,
    totalPaidUsdc: total,
    decisions,
    errors,
    rateChanges,
    investigationsHeld,
  };
}

/** Settles nothing and says so. The default until Circle is wired in. */
export class DryRunExecutor implements PayoutExecutor {
  async send({ decision }: { decision: PayoutDecision }): Promise<PaymentOutcome> {
    return {
      intentId: `pay-${decision.submissionId}-${decision.confirmedViews}`,
      executed: true,
      dryRun: true,
      detail: `would send ${decision.amountUsdc} USDC for ${decision.payableViews} confirmed views`,
      settledAt: new Date().toISOString(),
    };
  }
}
