/**
 * The service we sell to other agents.
 *
 * *Given a post URL and a brief: does this clip qualify, and how many of its
 * views have survived?*
 *
 * This is the payout engine's core competence, extracted and priced. Any
 * agent running creator campaigns needs exactly this call, and it is the
 * honest thing to list in Circle's marketplace — unlike the generic research
 * endpoint that shipped with the previous product and now has nothing to do
 * with what this repo builds.
 *
 * **The dwell answer requires history, and one call has none.** A stranger's
 * URL arriving for the first time has no yesterday to compare against, so the
 * first call cannot report surviving views and must not pretend to. Instead it
 * *starts the clock*: the count is recorded, and a later call reports what
 * survived between them. That is a real product shape rather than an apology —
 * a buying agent polls, and the answer sharpens.
 *
 * Every field that cannot be answered comes back explicitly null with a
 * reason. A verification service that fabricates the number it exists to
 * report is worse than one that says it does not know yet.
 */

import { confirmedViews, hasDwelled } from './views';
import { canonicalUrl, parsePostUrl } from './postref';
import type { Snapshot } from './types';

/** Judges a clip against a brief. The Gemini verifier implements this. */
export interface ClipVerifier {
  judge(input: {
    url: string;
    brief: string;
  }): Promise<{ pass: boolean; reasons: string[]; confidence: number; model: string }>;
}

/** Retrieves a view count from the platform. Never from the caller. */
export interface CountOracle {
  count(ref: { platform: string; postId: string }): Promise<bigint | undefined>;
}

/** Append-only snapshot history, keyed by canonical URL. */
export interface TrackingStore {
  snapshots(key: string): readonly Snapshot[];
  append(key: string, snapshot: Snapshot): void;
}

export class MemoryTrackingStore implements TrackingStore {
  private readonly byKey = new Map<string, Snapshot[]>();
  snapshots(key: string): readonly Snapshot[] {
    return this.byKey.get(key) ?? [];
  }
  append(key: string, snapshot: Snapshot): void {
    const list = this.byKey.get(key) ?? [];
    list.push(snapshot);
    this.byKey.set(key, list);
  }
}

export interface VerifyRequest {
  url: string;
  brief?: string;
  /** How long a view must persist to count. Defaults to 24h, capped at 7 days. */
  dwellHours?: number;
}

export interface VerifyResponse {
  url: string | null;
  platform: string | null;
  /** Null when no brief was supplied or no verifier is configured. */
  qualifies: boolean | null;
  reasons: string[];
  confidence: number | null;
  model: string | null;
  views: {
    latest: string | null;
    /** Views that survived the dwell window. Null until there is a yesterday. */
    confirmed: string | null;
    dwellHours: number;
    trackingSince: string | null;
    /** Why `confirmed` is null, when it is. */
    pending: string | null;
  };
  checkedAt: string;
  errors: string[];
}

const DEFAULT_DWELL_HOURS = 24;
const MAX_DWELL_HOURS = 24 * 7;

/**
 * What a buying agent gets for free, before deciding whether to pay.
 *
 * Deliberately excludes the numbers. It answers *"can you handle this link,
 * are you already watching it, and when will a real answer exist?"* — which is
 * everything an agent needs to plan a call, and nothing it could use instead
 * of making one. Reporting the confirmed count here would give away the thing
 * being sold.
 *
 * Free because it costs us nothing: URL parsing and a local history lookup, no
 * platform call and no model. The pattern is borrowed from the marketplace's
 * larger sellers, who list free health and lookup routes so an agent can
 * discover them and confirm they work before spending.
 */
export interface PreviewResponse {
  /** Whether we can verify this URL at all. */
  supported: boolean;
  url: string | null;
  platform: string | null;
  /** Whether this post is already under observation from an earlier call. */
  tracked: boolean;
  trackingSince: string | null;
  /** Whether a surviving-view figure exists yet — not the figure itself. */
  confirmedAvailable: boolean;
  /** When a surviving figure will first be available, if it is not yet. */
  readyAt: string | null;
  dwellHours: number;
  note: string;
  errors: string[];
}

export function previewClip(
  request: { url: string; dwellHours?: number },
  deps: { tracking: TrackingStore; now?: () => Date },
): PreviewResponse {
  const now = (deps.now ?? (() => new Date()))();
  const dwellHours = Math.min(
    Math.max(request.dwellHours ?? DEFAULT_DWELL_HOURS, 0),
    MAX_DWELL_HOURS,
  );
  const dwellMs = dwellHours * 3_600_000;

  const ref = parsePostUrl(request.url ?? '');
  if (!ref) {
    return {
      supported: false,
      url: null,
      platform: null,
      tracked: false,
      trackingSince: null,
      confirmedAvailable: false,
      readyAt: null,
      dwellHours,
      note: 'YouTube and X only.',
      errors: [
        'unrecognised post URL — Instagram, Facebook and TikTok need platform ' +
          'app review we do not hold, and accepting those links would promise ' +
          'a check we cannot perform.',
      ],
    };
  }

  const key = canonicalUrl(ref);
  const history = deps.tracking.snapshots(key);
  const earliest = history.reduce<string | null>((acc, s) => {
    if (!acc) return s.fetchedAt;
    return Date.parse(s.fetchedAt) < Date.parse(acc) ? s.fetchedAt : acc;
  }, null);
  const ready = hasDwelled(history, { dwellMs, now });

  return {
    supported: true,
    url: key,
    platform: ref.platform,
    tracked: history.length > 0,
    trackingSince: earliest,
    confirmedAvailable: ready,
    readyAt: ready || !earliest ? null : new Date(Date.parse(earliest) + dwellMs).toISOString(),
    dwellHours,
    note: earliest
      ? ready
        ? 'a surviving-view figure is available from /api/views or /api/verify'
        : `tracked, but not for ${dwellHours}h yet — call /api/views to refresh the count`
      : `not yet tracked — the first call to /api/views or /api/verify starts the ${dwellHours}h clock`,
    errors: [],
  };
}

export interface VerifyDeps {
  tracking: TrackingStore;
  oracle?: CountOracle;
  verifier?: ClipVerifier;
  now?: () => Date;
}

export async function verifyClip(
  request: VerifyRequest,
  deps: VerifyDeps,
): Promise<VerifyResponse> {
  const now = (deps.now ?? (() => new Date()))();
  const errors: string[] = [];

  const dwellHours = Math.min(
    Math.max(request.dwellHours ?? DEFAULT_DWELL_HOURS, 0),
    MAX_DWELL_HOURS,
  );
  const dwellMs = dwellHours * 3_600_000;

  const empty = (error: string): VerifyResponse => ({
    url: null,
    platform: null,
    qualifies: null,
    reasons: [],
    confidence: null,
    model: null,
    views: {
      latest: null,
      confirmed: null,
      dwellHours,
      trackingSince: null,
      pending: null,
    },
    checkedAt: now.toISOString(),
    errors: [error],
  });

  const ref = parsePostUrl(request.url ?? '');
  if (!ref) {
    return empty(
      'unrecognised post URL — YouTube and X only. Instagram, Facebook and ' +
        'TikTok need platform app review we do not hold, and accepting those ' +
        'links would promise a check we cannot perform.',
    );
  }

  const key = canonicalUrl(ref);

  // Counts first: the verdict is advisory, the count is the thing being sold.
  let latest: bigint | undefined;
  if (deps.oracle) {
    try {
      latest = await deps.oracle.count(ref);
      if (latest === undefined) errors.push('the platform did not return a view count');
    } catch (error) {
      errors.push(`view lookup failed: ${(error as Error).message}`);
    }
  } else {
    errors.push('no view oracle configured — counts unavailable');
  }

  if (latest !== undefined) {
    deps.tracking.append(key, {
      submissionId: key,
      views: latest,
      fetchedAt: now.toISOString(),
      source: ref.platform,
    });
  }

  const history = deps.tracking.snapshots(key);
  const dwelled = hasDwelled(history, { dwellMs, now });
  const confirmed = dwelled ? confirmedViews(history, { dwellMs, now }) : undefined;

  const earliest = history.reduce<string | null>((acc, s) => {
    if (!acc) return s.fetchedAt;
    return Date.parse(s.fetchedAt) < Date.parse(acc) ? s.fetchedAt : acc;
  }, null);

  let qualifies: boolean | null = null;
  let reasons: string[] = [];
  let confidence: number | null = null;
  let model: string | null = null;

  if (request.brief && deps.verifier) {
    try {
      const verdict = await deps.verifier.judge({ url: key, brief: request.brief });
      qualifies = verdict.pass;
      reasons = verdict.reasons;
      confidence = verdict.confidence;
      model = verdict.model;
    } catch (error) {
      errors.push(`verification failed: ${(error as Error).message}`);
    }
  } else if (request.brief) {
    errors.push('no verifier configured — the brief was not judged');
  }

  return {
    url: key,
    platform: ref.platform,
    qualifies,
    reasons,
    confidence,
    model,
    views: {
      latest: latest?.toString() ?? null,
      confirmed: confirmed?.toString() ?? null,
      dwellHours,
      trackingSince: earliest,
      pending: dwelled
        ? null
        : `this post has not been tracked for ${dwellHours}h yet — the count is ` +
          'recorded, call again later and the surviving figure will be here',
    },
    checkedAt: now.toISOString(),
    errors,
  };
}
