/**
 * The campaign agent as a long-lived service.
 *
 * Holds the store, the gate and the storage choice, so the HTTP layer stays a
 * router and nothing about scheduling leaks into the payout logic.
 *
 * **The tick endpoint is authenticated even though the service is not.** The
 * competition requires the deployment be reachable "free of charge and without
 * any restriction", so the console is deliberately public — but a public
 * endpoint that disburses USDC on request is an invitation, and rate limiting
 * would only slow it down. Cloud Scheduler sends a shared secret; nothing else
 * can start a pass.
 *
 * If no secret is configured the endpoint refuses to run at all rather than
 * running open. An unconfigured deployment that quietly accepts anonymous
 * payout triggers is a worse outcome than one that visibly does not tick.
 */

import { RollingWindowBudget } from '../budget';
import { Decimal } from '../decimal';
import { MandateStore } from '../mandates';
import { PaymentPolicyEngine } from '../policy';
import { PayoutGate } from './payout';
import {
  FileBlobStore,
  GcsBlobStore,
  MemoryBlobStore,
  type BlobStore,
} from './persistence';
import { EventLog } from './eventlog';
import { CampaignStore } from './store';
import { apply as applyEvent } from './eventlog';
import { MemoryTrackingStore, previewClip, verifyClip } from './verify';
import type { ClipVerifier, CountOracle } from './verify';
import { CircleCliExecutor } from './executor';
import { openCampaign, submitClip } from './intake';
import { oracleFromEnv } from './oracle';
import { verifierFromEnv } from './verifier';
import { agentFromEnv, type FraudInvestigator, type RateProposer } from './agent';
import { DryRunExecutor, runTick, type PayoutExecutor, type TickResult, type ViewOracle } from './tick';

/** No oracle configured yet: report "cannot tell", never a fabricated count. */
export const NULL_ORACLE: ViewOracle = { fetch: async () => undefined };

export function chooseBlobStore(env: Record<string, string | undefined> = Bun.env): BlobStore {
  if (env.GCS_BUCKET) return new GcsBlobStore(env.GCS_BUCKET);
  if (env.STATE_DIR) return new FileBlobStore(env.STATE_DIR);
  // Explicitly ephemeral. Fine for tests; on Cloud Run it means the dwell
  // window can never be satisfied, which `/api/campaign` reports rather than
  // hides.
  return new MemoryBlobStore();
}

/**
 * Compare without leaking length or position through timing.
 *
 * The payoff is small — an attacker guessing a secret over the internet has
 * bigger problems than timing — but the cost is four lines.
 */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export interface CampaignRuntimeOptions {
  blobs?: BlobStore;
  counts?: CountOracle;
  verifier?: ClipVerifier;
  oracle?: ViewOracle;
  executor?: PayoutExecutor;
  mandates?: MandateStore;
  /** Injectable so a test can run the loop without a network. */
  agent?: { rate?: RateProposer; investigator?: FraudInvestigator };
  env?: Record<string, string | undefined>;
}

export class CampaignRuntime {
  readonly store = new CampaignStore();
  readonly gate: PayoutGate;
  readonly mandates: MandateStore;
  private readonly blobs: BlobStore;
  private readonly log: EventLog;
  private readonly oracle: ViewOracle;
  private readonly executor: PayoutExecutor;
  private readonly env: Record<string, string | undefined>;
  /** History for the public verification service, separate from campaigns. */
  private readonly tracking = new MemoryTrackingStore();
  private readonly counts?: CountOracle;
  private readonly verifier?: ClipVerifier;
  /** Empty without credentials, and empty is a working configuration: the
   *  tick stays purely deterministic rather than falling back to a stub. */
  private readonly agent: { rate?: RateProposer; investigator?: FraudInvestigator };
  private loaded = false;
  private lastTick?: TickResult;

  constructor(options: CampaignRuntimeOptions = {}) {
    this.env = options.env ?? Bun.env;
    this.blobs = options.blobs ?? chooseBlobStore(this.env);
    this.log = new EventLog(this.blobs);
    // The tick's view source is the same YouTube oracle the paid endpoint
    // uses; NULL_ORACLE only when no key is configured.
    this.oracle = options.oracle ?? oracleFromEnv(this.env) ?? NULL_ORACLE;
    // With a wallet configured, settlement goes through the real CLI — in
    // estimate mode unless mainnet is explicitly armed, so the path is
    // exercised end to end before it can move anything.
    //
    // The wallet is chosen *by* the network rather than configured beside it.
    // A Circle agent wallet exists on one network: the testnet wallet cannot
    // send on BASE and the mainnet wallet cannot send on BASE-SEPOLIA. Two
    // independent settings would make the dangerous mistake expressible —
    // arming mainnet while still pointing at the testnet wallet, or the
    // reverse — and neither fails in an obvious way. Selecting one from the
    // other means the mismatch cannot be configured at all.
    this.executor = options.executor ?? this.buildExecutor();
    this.mandates = options.mandates ?? new MandateStore();
    // Real when the keys are present, absent otherwise — never a stub that
    // answers zero or always passes. Every consumer reports the absence.
    this.counts = options.counts ?? oracleFromEnv(this.env);
    this.verifier = options.verifier ?? verifierFromEnv(this.env);
    this.agent = options.agent ?? agentFromEnv(this.env);

    this.gate = new PayoutGate(
      this.store,
      new PaymentPolicyEngine(
        {
          dryRun: this.env.ALLOW_MAINNET !== 'true',
          killSwitch: this.env.KILL_SWITCH === 'true',
          absoluteMaxPerPaymentUsdc: new Decimal(this.env.MAX_PER_PAYMENT_USDC ?? '5.00'),
          allowMainnet: this.env.ALLOW_MAINNET === 'true',
        },
        this.mandates,
        new RollingWindowBudget({ defaultCapUsdc: this.env.WINDOW_BUDGET_USDC ?? '25.00' }),
      ),
    );
  }

  /**
   * The executor, with the sending wallet chosen by the network.
   *
   * Two separate flags, because they are two separate questions and the old
   * single flag conflated them. `ALLOW_MAINNET` answers *which network is this
   * deployment on* — it selects the wallet and unlocks mainnet chains in the
   * policy engine. `BROADCAST` answers *should a decision actually move money*
   * — without it the CLI runs with `--estimate`, exercising the real wallet
   * and the real chain but stopping short of broadcasting.
   *
   * Conflated, the only way to broadcast a testnet payout was to set the flag
   * that also unlocked mainnet. Separated, testnet can settle for real while
   * mainnet stays refused, which is the combination we actually want.
   *
   * Fails closed at construction rather than at the first payout, because the
   * first payout is the one carrying money.
   */
  private buildExecutor(): PayoutExecutor {
    const onMainnet = this.env.ALLOW_MAINNET === 'true';
    const wallet = (
      onMainnet ? this.env.MAINNET_CAMPAIGN_WALLET : this.env.CAMPAIGN_WALLET
    )?.trim();

    if (onMainnet && !wallet) {
      throw new Error(
        'ALLOW_MAINNET=true but MAINNET_CAMPAIGN_WALLET is unset. Refusing to start: ' +
          'settling on mainnet from the testnet wallet is not a recoverable mistake.',
      );
    }
    if (!wallet) return new DryRunExecutor();

    return new CircleCliExecutor({
      fromAddress: wallet,
      dryRun: this.env.BROADCAST !== 'true',
    });
  }

  /** Replay the log into the store. Idempotent, so every route may call it. */
  async ready(): Promise<void> {
    if (this.loaded) return;
    await this.log.hydrate(this.store);
    this.loaded = true;
  }

  /**
   * Record a fact and apply it.
   *
   * The only supported way to change campaign state: the log is the source of
   * truth, and an in-memory mutation nobody wrote down dies with the instance.
   */
  async record(event: Parameters<EventLog['append']>[0], at: Date = new Date()): Promise<boolean> {
    const written = await this.log.append(event, at);
    if (written) applyEvent(this.store, event);
    return written;
  }

  /** The chain, recomputed from the events. Anyone can check this. */
  async chain() {
    return this.log.chain();
  }

  async tick(now?: Date): Promise<TickResult> {
    await this.ready();
    this.lastTick = await runTick(
      {
        store: this.store,
        gate: this.gate,
        oracle: this.oracle,
        executor: this.executor,
        log: this.log,
        agent: this.agent,
      },
      { agentId: this.env.AGENT_ID ?? 'campaign-agent', now },
    );
    return this.lastTick;
  }

  /**
   * What a creator sees before deciding whether to invest the effort.
   *
   * Publishing the remaining pool is the point: the loudest complaint in this
   * market is doing real work against a budget that had already emptied, and
   * a visible pot is the one thing a fiat rail structurally cannot offer.
   */
  async publicView() {
    await this.ready();
    const state = this.store.exportState();
    return {
      persistence: this.blobs.constructor.name,
      ephemeral: this.blobs instanceof MemoryBlobStore,
      // Stated rather than discovered: a campaign with no verifier holds every
      // clip on `no_verdict`, and one with no oracle never confirms a view.
      verifier: this.verifier ? 'gemini' : 'not configured (GOOGLE_API_KEY)',
      viewOracle: this.counts ? 'youtube' : 'not configured (YOUTUBE_API_KEY)',
      campaigns: state.campaigns.map((c) => ({
        campaignId: c.campaignId,
        brief: c.brief,
        status: c.status,
        cpmUsdc: c.cpmUsdc.toString(),
        poolUsdc: c.poolUsdc.toString(),
        remainingUsdc: this.store.remainingPool(c.campaignId).toString(),
        perCreatorCapUsdc: c.perCreatorCapUsdc.toString(),
        dwellHours: Math.round(c.dwellMs / 3_600_000),
        platforms: c.platforms,
        endsAt: c.endsAt,
        paidOut: this.store.payoutsFor(c.campaignId).length,
      })),
      lastTick: this.lastTick && {
        startedAt: this.lastTick.startedAt,
        paid: this.lastTick.paid,
        held: this.lastTick.held,
        blocked: this.lastTick.blocked,
        needsApproval: this.lastTick.needsApproval,
        totalPaidUsdc: this.lastTick.totalPaidUsdc.toString(),
        errors: this.lastTick.errors,
      },
    };
  }

  /**
   * Free. Can we handle this link, are we already watching it, and when will a
   * real answer exist? No platform call and no model, so it costs us nothing —
   * and it deliberately omits the numbers, which are the thing being sold.
   */
  async handlePreview(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const target =
      url.searchParams.get('url') ??
      ((await request.json().catch(() => ({}))) as { url?: string }).url;
    if (!target) return Response.json({ error: 'url is required' }, { status: 400 });
    const dwell = Number(url.searchParams.get('dwellHours'));
    return Response.json(
      previewClip(
        { url: target, dwellHours: Number.isFinite(dwell) && dwell > 0 ? dwell : undefined },
        { tracking: this.tracking },
      ),
    );
  }

  /**
   * Counts only: latest and surviving views, no verdict.
   *
   * Priced well below `/api/verify` because no model runs. A caller who only
   * wants the surviving number should not pay for a video to be watched.
   */
  async handleViews(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      url?: string;
      brief?: string;
      dwellHours?: number;
    };
    if (!body.url) return Response.json({ error: 'url is required' }, { status: 400 });
    const result = await verifyClip(
      { url: body.url, dwellHours: body.dwellHours },
      { tracking: this.tracking, oracle: this.counts },
    );
    // Say so rather than silently dropping it — the caller paid the cheaper
    // price and would otherwise wonder where their verdict went.
    if (body.brief) {
      result.errors.push(
        'a brief was supplied but /api/views does not judge it — no model runs at ' +
          'this price. Use /api/verify for a verdict.',
      );
    }
    return Response.json(result);
  }

  /**
   * The service we sell to other agents: does this clip qualify, and how many
   * of its views survived?
   *
   * Payment is checked by the caller (`server.ts`) via x402 before this runs —
   * the same 402 handshake Circle's marketplace expects, so a buying agent
   * needs no account with us and no API key.
   */
  async handleVerify(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      url?: string;
      brief?: string;
      dwellHours?: number;
    };
    if (!body.url) {
      return Response.json({ error: 'url is required' }, { status: 400 });
    }
    const result = await verifyClip(
      { url: body.url, brief: body.brief, dwellHours: body.dwellHours },
      { tracking: this.tracking, oracle: this.counts, verifier: this.verifier },
    );
    return Response.json(result);
  }

  /**
   * `POST /api/campaigns` — a brand opens a campaign.
   *
   * Operator-gated with the same secret as the tick, because declaring a pool
   * is declaring an intention to pay. Anyone who can call this can commit the
   * operator's money.
   */
  async handleOpenCampaign(request: Request): Promise<Response> {
    const guard = this.requireOperator(request);
    if (guard) return guard;
    await this.ready();

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = openCampaign(body);
    if (!result.ok) {
      return Response.json({ error: result.error, field: result.field }, { status: 400 });
    }

    await this.record({ type: 'campaign_upserted', campaign: result.value });
    const c = result.value;
    return Response.json(
      {
        campaignId: c.campaignId,
        brief: c.brief,
        poolUsdc: c.poolUsdc.toString(),
        cpmUsdc: c.cpmUsdc.toString(),
        perCreatorCapUsdc: c.perCreatorCapUsdc.toString(),
        dwellHours: Math.round(c.dwellMs / 3_600_000),
        settlementDays: Math.round(c.settlementWindowMs / 86_400_000),
        platforms: c.platforms,
        chain: c.chain,
        endsAt: c.endsAt,
        submitTo: `/api/submissions`,
      },
      { status: 201 },
    );
  }

  /**
   * `POST /api/submissions` — a creator submits a clip.
   *
   * Deliberately public. The payout address is the identity, because it is the
   * thing that receives money; requiring a signup before someone can be paid
   * is the friction this product exists to remove.
   */
  async handleSubmit(request: Request): Promise<Response> {
    await this.ready();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const campaign = this.store.campaign(String(body.campaignId ?? ''));
    const result = submitClip(campaign, body);
    if (!result.ok) {
      return Response.json({ error: result.error, field: result.field }, { status: 400 });
    }

    const { submission, creator } = result.value;
    await this.record({ type: 'creator_upserted', creator });
    const isNew = await this.record({ type: 'submission_accepted', submission });

    const terms = submission.acceptedTerms;
    return Response.json(
      {
        submissionId: submission.submissionId,
        alreadySubmitted: !isNew,
        url: submission.url,
        platform: submission.platform,
        // The deal, echoed back. It is frozen from this moment and the brand
        // cannot change it under work already accepted.
        agreedTerms: {
          cpmUsdc: terms.cpmUsdc.toString(),
          perCreatorCapUsdc: terms.perCreatorCapUsdc.toString(),
          dwellHours: Math.round(terms.dwellMs / 3_600_000),
          acceptedAt: terms.acceptedAt,
          guaranteedUntil: terms.settlementDeadline,
        },
        poolRemainingUsdc: this.store.remainingPool(submission.campaignId).toString(),
        next:
          'your views are counted from now. nothing pays until they have held ' +
          `for ${Math.round(terms.dwellMs / 3_600_000)}h — check /api/submissions/` +
          submission.submissionId,
      },
      { status: isNew ? 201 : 200 },
    );
  }

  /** `GET /api/submissions/:id` — what a creator sees about their own clip. */
  async handleSubmissionStatus(submissionId: string): Promise<Response> {
    await this.ready();
    const submission = this.store.submission(submissionId);
    if (!submission) return Response.json({ error: 'unknown submission' }, { status: 404 });

    const decision = this.gate.decide(submissionId, {
      agentId: this.env.AGENT_ID ?? 'campaign-agent',
    });
    const verdict = this.store.latestVerdict(submissionId);

    return Response.json({
      submissionId,
      url: submission.url,
      status: decision.disposition,
      // Written for the creator, not a log parser — including on a refusal.
      reason: decision.reason,
      verdict: verdict && { pass: verdict.pass, reasons: verdict.reasons, at: verdict.at },
      confirmedViews: decision.confirmedViews.toString(),
      paidForViews: this.store.viewsPaidTo(submissionId).toString(),
      earnedUsdc: this.store.spentOnCreator(submission.campaignId, submission.creatorId).toString(),
      guaranteedUntil: submission.acceptedTerms.settlementDeadline,
    });
  }

  /** Shared operator gate. Same reasoning as the tick: fail closed. */
  private requireOperator(request: Request): Response | null {
    const expected = this.env.TICK_SECRET;
    if (!expected) {
      return Response.json(
        { error: 'TICK_SECRET is not configured — refusing operator actions' },
        { status: 503 },
      );
    }
    if (!secretMatches(request.headers.get('x-tick-secret'), expected)) {
      return Response.json({ error: 'unauthorised' }, { status: 401 });
    }
    return null;
  }

  /** Route handler for `POST /api/tick`. Returns null when the path isn't ours. */
  async handleTick(request: Request): Promise<Response> {
    const expected = this.env.TICK_SECRET;
    if (!expected) {
      return Response.json(
        {
          error: 'TICK_SECRET is not configured',
          detail:
            'refusing to run a payout pass on an unauthenticated endpoint — set ' +
            'TICK_SECRET and send it as x-tick-secret',
        },
        { status: 503 },
      );
    }
    if (!secretMatches(request.headers.get('x-tick-secret'), expected)) {
      return Response.json({ error: 'unauthorised' }, { status: 401 });
    }

    const result = await this.tick();
    return Response.json({
      ...result,
      totalPaidUsdc: result.totalPaidUsdc.toString(),
      decisions: result.decisions.map((d) => ({
        submissionId: d.submissionId,
        disposition: d.disposition,
        control: d.control,
        reason: d.reason,
        confirmedViews: d.confirmedViews.toString(),
        payableViews: d.payableViews.toString(),
        amountUsdc: d.amountUsdc.toString(),
      })),
    });
  }
}
