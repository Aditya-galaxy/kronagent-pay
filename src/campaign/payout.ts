/**
 * The payout gate — between "the agent thinks this clip earned something" and
 * "USDC left the campaign wallet".
 *
 * This composes with `PaymentPolicyEngine` rather than replacing or modifying
 * it. The money controls that engine enforces — the absolute ceiling, the
 * mandate, the mandate cap, the rolling window — are already property-tested
 * and are not touched here. What this file adds are the checks that only make
 * sense for a campaign, and it runs them *first*, so a submission that has no
 * business being paid never reaches the payment path at all.
 *
 * Order of evaluation, first match wins:
 *
 *   1. Unknown submission / campaign / creator   -> blocked
 *   2. Past the agreed settlement deadline       -> blocked
 *   3. No verdict, or the verdict failed         -> blocked
 *   4. Nothing has survived the dwell period yet -> held
 *   5. No views beyond what was already paid     -> no_op
 *   6. Would exceed the campaign pool            -> blocked
 *   7. Over this creator's cap for the campaign  -> requires_approval
 *   8. -> PaymentPolicyEngine.decide()
 *
 * **The live campaign is not consulted for an accepted clip.** Rate, dwell and
 * per-creator cap all come from `submission.acceptedTerms`, frozen when the
 * clip was taken in. A brand may pause or end a campaign — that refuses *new*
 * work, at `acceptSubmission`, before a creator has spent any effort. It does
 * not abandon work already accepted. Without this the system reproduces the
 * complaint it was built to answer.
 *
 * Three of these deserve a note.
 *
 * **The pool check blocks rather than escalating.** Every other cap in this
 * system routes to a human, because a wrongly-held payment costs attention and
 * a wrongly-sent one is irreversible. The pool is different in kind: it is not
 * a risk threshold but the total the operator funded, and "ask a human to
 * approve exceeding the budget" is how a budget stops being one. Raising it
 * means funding more, which is a deliberate act on a different code path.
 *
 * **The rolling window is doing new work here.** It was written to stop a
 * thousand small payments draining a wallet. In a campaign it is the velocity
 * limiter: it bounds USDC per hour independently of how large the pool is, so
 * a compromised agent holding entirely valid mandates still cannot empty a
 * $5,000 pool in an afternoon.
 */

import { Decimal } from '../decimal';
import type { PaymentPolicyEngine } from '../policy';
import type { PaymentDecision, PaymentIntent, PolicyControl } from '../schemas';
import type { CampaignView } from './store';
import { termsExpired } from './terms';
import { confirmedViews, earningsFor, hasDwelled, payableViews } from './views';

export type PayoutControl =
  | 'unknown_entity'
  | 'campaign_inactive'
  | 'terms_expired'
  | 'no_verdict'
  | 'verdict_failed'
  | 'dwell_unmet'
  | 'nothing_payable'
  | 'campaign_pool'
  | 'per_creator_cap';

/**
 * `held` and `no_op` are payout-specific and deliberately not folded into the
 * payment dispositions. "Come back tomorrow" and "you are already paid up to
 * date" are both non-payments, but neither is a refusal, and showing a creator
 * `blocked` for either would be a lie about what happened.
 */
export type PayoutDisposition =
  | 'auto_pay'
  | 'requires_approval'
  | 'blocked'
  | 'held'
  | 'no_op';

export interface PayoutDecision {
  readonly submissionId: string;
  readonly campaignId: string;
  readonly creatorId: string;
  readonly disposition: PayoutDisposition;
  readonly control: PayoutControl | PolicyControl;
  /** Written for the creator who is reading it, not for a log parser. */
  readonly reason: string;
  readonly confirmedViews: bigint;
  readonly payableViews: bigint;
  readonly amountUsdc: Decimal;
  readonly decidedAt: string;
  /** The delegated payment verdict, present once the campaign checks passed. */
  readonly payment?: PaymentDecision;
}

export interface PayoutGateOptions {
  readonly agentId: string;
  readonly now?: Date;
}

export class PayoutGate {
  constructor(
    private readonly view: CampaignView,
    private readonly payments: PaymentPolicyEngine,
  ) {}

  decide(submissionId: string, options: PayoutGateOptions): PayoutDecision {
    const now = options.now ?? new Date();
    const zero = new Decimal(0n);
    const at = now.toISOString();

    const submission = this.view.submission(submissionId);
    const campaign = submission ? this.view.campaign(submission.campaignId) : undefined;
    const creator = submission ? this.view.creator(submission.creatorId) : undefined;

    const base = {
      submissionId,
      campaignId: submission?.campaignId ?? '',
      creatorId: submission?.creatorId ?? '',
      decidedAt: at,
      confirmedViews: 0n,
      payableViews: 0n,
      amountUsdc: zero,
    };

    if (!submission || !campaign || !creator) {
      return {
        ...base,
        disposition: 'blocked',
        control: 'unknown_entity',
        reason:
          'submission, campaign or creator is unknown — a payout is never ' +
          'constructed from partial state',
      };
    }

    // From here the live campaign no longer governs this clip. It was accepted
    // under terms, and those terms are what it settles under — pausing or
    // ending a campaign refuses *new* work (see `acceptSubmission`), it does
    // not abandon work already taken.
    const terms = submission.acceptedTerms;

    if (termsExpired(terms, now)) {
      return {
        ...base,
        disposition: 'blocked',
        control: 'terms_expired',
        reason:
          `the settlement window for this clip closed on ${terms.settlementDeadline} — ` +
          'the brand was bound until then, and is not after',
      };
    }

    if (campaign.status === 'draft') {
      // Should be unreachable: acceptance refuses a draft campaign. Defensive,
      // because the failure mode is paying out of an unfunded pool.
      return {
        ...base,
        disposition: 'blocked',
        control: 'campaign_inactive',
        reason: `campaign ${campaign.campaignId} is still a draft`,
      };
    }

    const verdict = this.view.latestVerdict(submissionId);
    if (!verdict) {
      return {
        ...base,
        disposition: 'blocked',
        control: 'no_verdict',
        reason: 'this clip has not been checked against the brief yet',
      };
    }
    if (!verdict.pass) {
      return {
        ...base,
        disposition: 'blocked',
        control: 'verdict_failed',
        reason:
          `this clip did not meet the brief: ${verdict.reasons.join('; ') || 'no reason given'}`,
      };
    }

    const snapshots = this.view.snapshots(submissionId);
    if (!hasDwelled(snapshots, { dwellMs: terms.dwellMs, now })) {
      const hours = Math.round(terms.dwellMs / 3_600_000);
      return {
        ...base,
        disposition: 'held',
        control: 'dwell_unmet',
        reason:
          `views have to hold for ${hours}h before they are paid for — ` +
          'this is a wait, not a rejection',
      };
    }

    const confirmed = confirmedViews(snapshots, { dwellMs: terms.dwellMs, now });
    const payable = payableViews(confirmed, this.view.viewsPaidTo(submissionId));
    // The rate the creator agreed to, not whatever the brand set since.
    const amount = earningsFor(payable, terms.cpmUsdc);

    if (payable <= 0n || !amount.isPositive()) {
      return {
        ...base,
        confirmedViews: confirmed,
        disposition: 'no_op',
        control: 'nothing_payable',
        reason:
          `no new confirmed views since the last payout (${confirmed} confirmed, ` +
          `already paid to ${this.view.viewsPaidTo(submissionId)})`,
      };
    }

    const withAmounts = { ...base, confirmedViews: confirmed, payableViews: payable, amountUsdc: amount };

    const spent = this.view.spentOnCampaign(campaign.campaignId);
    if (spent.plus(amount).gt(campaign.poolUsdc)) {
      return {
        ...withAmounts,
        disposition: 'blocked',
        control: 'campaign_pool',
        reason:
          `${amount} USDC would take the campaign to ${spent.plus(amount)} of its ` +
          `${campaign.poolUsdc} USDC pool — the pool is the whole budget, not a ` +
          'threshold to escalate past',
      };
    }

    const creatorSpent = this.view.spentOnCreator(campaign.campaignId, creator.creatorId);
    if (creatorSpent.plus(amount).gt(terms.perCreatorCapUsdc)) {
      return {
        ...withAmounts,
        disposition: 'requires_approval',
        control: 'per_creator_cap',
        reason:
          `${creator.creatorId} would reach ${creatorSpent.plus(amount)} USDC on this ` +
          `campaign, over the ${terms.perCreatorCapUsdc} USDC per-creator cap`,
      };
    }

    const intent: PaymentIntent = {
      intentId: `pay-${submissionId}-${confirmed}`,
      counterparty: creator.payoutAddress,
      amountUsdc: amount,
      rail: 'direct_transfer',
      chain: campaign.chain,
      purpose:
        `${payable} confirmed views on ${submission.url} at ${terms.cpmUsdc} USDC/1k (agreed ${terms.acceptedAt})`,
      agentId: options.agentId,
      requestedAt: at,
      context: { submissionId, campaignId: campaign.campaignId, verdictId: verdict.verdictId },
    };

    const payment = this.payments.decide(intent, now);

    return {
      ...withAmounts,
      disposition: payment.disposition,
      control: payment.control,
      reason: payment.reason,
      payment,
    };
  }
}
