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
