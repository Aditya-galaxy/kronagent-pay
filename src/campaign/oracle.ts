/**
 * Where view counts come from.
 *
 * **The platform's API, never the creator.** That is the whole rule. A count
 * supplied by the person being paid is not evidence, and accepting one would
 * make the dwell mechanic decorative — an attacker would simply report a big
 * number twice.
 *
 * Every failure resolves to `undefined`, meaning *"could not tell"*, which the
 * rest of the system treats as different from zero. A zero would look like a
 * clip nobody watched and could silently reduce a payout; "could not tell"
 * leaves the last good snapshot standing and lets the gate decide on that.
 */

import type { PostRef } from './postref';
import type { CountOracle } from './verify';
import type { ViewOracle } from './tick';
import type { Submission } from './types';

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3/videos';

export interface OracleOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Surfaced so a quota exhaustion is visible rather than silent. */
  log?: (line: string) => void;
}

/**
 * YouTube Data API v3.
 *
 * One unit per call against a 10,000/day quota, and that quota cannot be
 * raised by enabling billing — only by passing a compliance audit. So the
 * number of clips a campaign can track per day has a hard ceiling, and it is
 * recorded in ARCHITECTURE §4 rather than discovered in production.
 */
export class YouTubeOracle implements CountOracle {
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;

  constructor(private readonly options: OracleOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? (() => {});
  }

  async count(ref: { platform: string; postId: string }): Promise<bigint | undefined> {
    if (ref.platform !== 'youtube') return undefined;

    const params = new URLSearchParams({
      part: 'statistics',
      id: ref.postId,
      key: this.options.apiKey,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(`${YOUTUBE_API}?${params}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      this.log(`youtube: ${ref.postId} unreachable — ${(error as Error).message}`);
      return undefined;
    }

    if (response.status === 403) {
      // Almost always quota. Worth saying out loud: silently returning
      // undefined for a whole day would look like every clip going quiet.
      this.log(`youtube: 403 for ${ref.postId} — quota exhausted or key restricted`);
      return undefined;
    }
    if (!response.ok) {
      this.log(`youtube: HTTP ${response.status} for ${ref.postId}`);
      return undefined;
    }

    const body = (await response.json().catch(() => ({}))) as {
      items?: { statistics?: { viewCount?: string } }[];
    };

    const item = body.items?.[0];
    // An empty `items` means deleted, private or never existed. All three are
    // "we cannot tell you", not "zero views" — and a clip that vanishes after
    // being paid is exactly what the dwell window is for.
    if (!item) {
      this.log(`youtube: ${ref.postId} returned no video — deleted, private, or wrong id`);
      return undefined;
    }

    const raw = item.statistics?.viewCount;
    // Counts are hidden on some videos. Absent is not zero.
    if (raw === undefined) {
      this.log(`youtube: ${ref.postId} has view counts hidden`);
      return undefined;
    }

    try {
      const views = BigInt(raw);
      return views >= 0n ? views : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * X, deliberately unimplemented.
 *
 * The API went pay-per-use in February 2026 — roughly $0.005 per post read,
 * with no free tier for new developers — so it needs a funded account that
 * does not exist yet. Returning `undefined` is the honest state: X submissions
 * are accepted and simply never accrue a confirmed count, which the gate
 * reports as `dwell_unmet` rather than as a rejection.
 */
export class XOracleUnavailable implements CountOracle {
  async count(): Promise<undefined> {
    return undefined;
  }
}

/** Routes to whichever platform a submission is on. */
export class PlatformOracle implements CountOracle, ViewOracle {
  constructor(private readonly byPlatform: Record<string, CountOracle>) {}

  async count(ref: { platform: string; postId: string }): Promise<bigint | undefined> {
    return this.byPlatform[ref.platform]?.count(ref);
  }

  /** The `ViewOracle` shape the tick loop uses. */
  async fetch(submission: Submission): Promise<bigint | undefined> {
    return this.count({ platform: submission.platform, postId: submission.postId });
  }
}

/**
 * Build from the environment.
 *
 * Returns `undefined` when no key is configured, so the caller reports "no
 * oracle" rather than quietly substituting one that always says zero.
 */
export function oracleFromEnv(
  env: Record<string, string | undefined> = Bun.env,
  fetchImpl?: typeof fetch,
): PlatformOracle | undefined {
  const key = env.YOUTUBE_API_KEY?.trim();
  if (!key) return undefined;
  return new PlatformOracle({
    youtube: new YouTubeOracle({ apiKey: key, fetchImpl }),
    x: new XOracleUnavailable(),
  });
}

export type { PostRef };
