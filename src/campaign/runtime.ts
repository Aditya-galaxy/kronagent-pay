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
  loadInto,
  type BlobStore,
} from './persistence';
import { CampaignStore } from './store';
import { MemoryTrackingStore, previewClip, verifyClip } from './verify';
import type { ClipVerifier, CountOracle } from './verify';
import { CircleCliExecutor } from './executor';
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
  env?: Record<string, string | undefined>;
}

export class CampaignRuntime {
  readonly store = new CampaignStore();
  readonly gate: PayoutGate;
  readonly mandates: MandateStore;
  private readonly blobs: BlobStore;
  private readonly oracle: ViewOracle;
  private readonly executor: PayoutExecutor;
  private readonly env: Record<string, string | undefined>;
  /** History for the public verification service, separate from campaigns. */
  private readonly tracking = new MemoryTrackingStore();
  private readonly counts?: CountOracle;
  private readonly verifier?: ClipVerifier;
  private loaded = false;
  private lastTick?: TickResult;

  constructor(options: CampaignRuntimeOptions = {}) {
    this.env = options.env ?? Bun.env;
    this.blobs = options.blobs ?? chooseBlobStore(this.env);
    this.oracle = options.oracle ?? NULL_ORACLE;
    // With a wallet configured, settlement goes through the real CLI — in
    // estimate mode unless mainnet is explicitly armed, so the path is
    // exercised end to end before it can move anything.
    this.executor =
      options.executor ??
      (this.env.CAMPAIGN_WALLET
        ? new CircleCliExecutor({
            fromAddress: this.env.CAMPAIGN_WALLET,
            dryRun: this.env.ALLOW_MAINNET !== 'true',
          })
        : new DryRunExecutor());
    this.mandates = options.mandates ?? new MandateStore();
    this.counts = options.counts;
    this.verifier = options.verifier;

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

  /** Hydrate from durable storage. Idempotent, so every route may call it. */
  async ready(): Promise<void> {
    if (this.loaded) return;
    await loadInto(this.store, this.blobs);
    this.loaded = true;
  }

  async tick(now?: Date): Promise<TickResult> {
    await this.ready();
    this.lastTick = await runTick(
      {
        store: this.store,
        gate: this.gate,
        oracle: this.oracle,
        executor: this.executor,
        blobs: this.blobs,
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
