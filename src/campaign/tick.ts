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
 * **State is persisted after each settlement, not at the end of the tick.**
 * A crash between paying and persisting is the one window where a restart
 * could pay twice. Narrowing it to a single payout is worth the extra writes,
 * and the intent id is derived from the submission and its confirmed view
 * count — `pay-<submission>-<views>` — so a settlement layer that dedupes on
 * intent id closes the window entirely.
 *
 * **One submission's failure never aborts the tick.** An oracle timing out on
 * a single clip must not stop every other creator getting paid. It also must
 * not cause a payout: a missing view count leaves the last snapshot standing,
 * and the gate decides on that.
 */

import { Decimal } from '../decimal';
import type { PaymentOutcome } from '../schemas';
import type { PayoutDecision, PayoutGate } from './payout';
import type { BlobStore } from './persistence';
import { saveFrom } from './persistence';
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
  blobs?: BlobStore;
  sink?: DecisionSink;
}

export interface TickResult {
  readonly startedAt: string;
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
  const { store, gate, oracle, executor, blobs, sink } = deps;

  const decisions: PayoutDecision[] = [];
  const errors: string[] = [];
  let paid = 0;
  let held = 0;
  let blocked = 0;
  let needsApproval = 0;
  let total = new Decimal(0n);
  let submissionCount = 0;

  const campaigns = store.exportState().campaigns.filter((c) => c.status === 'active');
  const submissions = store.exportState().submissions;

  for (const campaign of campaigns) {
    for (const submission of submissions) {
      if (submission.campaignId !== campaign.campaignId) continue;
      submissionCount += 1;

      try {
        const views = await oracle.fetch(submission);
        if (views !== undefined) {
          store.addSnapshot({
            submissionId: submission.submissionId,
            views,
            fetchedAt: now.toISOString(),
            source: submission.platform,
          });
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

        store.recordPayout({
          payoutId: `po-${submission.submissionId}-${decision.confirmedViews}`,
          submissionId: submission.submissionId,
          campaignId: campaign.campaignId,
          creatorId: creator.creatorId,
          viewsPaidTo: decision.confirmedViews,
          amountUsdc: decision.amountUsdc,
          at: now.toISOString(),
          txHash: outcome.txHash,
          explorerUrl: outcome.explorerUrl,
        });
        paid += 1;
        total = total.plus(decision.amountUsdc);

        // Persist per payout, not per tick: this is the only window in which a
        // crash could pay the same views twice.
        if (blobs) await saveFrom(store, blobs);
      } catch (error) {
        // One clip's oracle timing out must not stop everyone else being paid.
        errors.push(`${submission.submissionId}: ${(error as Error).message}`);
      }
    }
  }

  if (blobs) await saveFrom(store, blobs);

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
