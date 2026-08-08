/**
 * One tick per window, across every instance.
 *
 * `CampaignRuntime.tick` is single-flight *within* a process, which handles
 * Cloud Scheduler retrying against an instance that is already working. It
 * does nothing about two instances. Cloud Run scales on request concurrency,
 * a scheduled POST is a request, and a retry can land on a cold second
 * instance while the first is mid-pass. Both then read the same `viewsPaidTo`
 * and reach the executor for payouts the other has already sent.
 *
 * Circle's idempotency key does catch that — a replay returns the same
 * transaction hash. But it is the last line, it is someone else's system, and
 * it only holds because every payout id is deterministic. A bug that made an
 * id vary per pass would remove the protection silently, and nothing here
 * would notice.
 *
 * ## Why a time bucket rather than an expiring lease
 *
 * The blob store offers exactly one atomic operation: `putIfAbsent`. There is
 * no compare-and-swap and no delete. A conventional lease — write a holder
 * with an expiry, let a later instance take over once it lapses — needs CAS
 * to hand over safely. Built on `put`, the handover has a window where two
 * instances both believe they hold it, which is precisely the failure the
 * lease exists to prevent, now with the added confidence of having a lease.
 *
 * So the key carries the window instead: `leases/tick-<bucket>.json`, where
 * the bucket is the floor of the current time. Whoever creates that key owns
 * that window. There is no expiry to misjudge, no clock skew to arbitrate,
 * no handover to race. The next window is a different key and simply
 * proceeds.
 *
 * The cost is honest and worth stating: **a pass that crashes mid-window
 * loses that window.** No one retries inside it, because the key is taken.
 * That is acceptable here because a tick is idempotent and the schedule is
 * hourly — the next pass sees the same unsettled submissions and pays them,
 * one window late. Losing an hour is recoverable; paying twice is not.
 */

export const LEASE_PREFIX = 'leases/';

/** Long enough to cover a pass and a scheduler retry, short of the schedule. */
export const DEFAULT_LEASE_WINDOW_MS = 5 * 60 * 1000;

export interface LeaseHolder {
  readonly holder: string;
  readonly acquiredAt: string;
  readonly windowMs: number;
}

/** Minimal surface, so this is testable without a bucket. */
export interface LeaseStore {
  putIfAbsent(key: string, value: string): Promise<boolean>;
  get(key: string): Promise<string | undefined>;
}

/**
 * The key for the window containing `now`.
 *
 * Deliberately derived from the clock rather than from a counter: two
 * instances that never talk to each other still compute the same key, which
 * is the entire mechanism. Instances whose clocks disagree by less than a
 * window agree on the bucket; beyond that they may each take a window, which
 * degrades to the behaviour we had before rather than to something worse.
 */
export function leaseKeyFor(now: Date, windowMs: number = DEFAULT_LEASE_WINDOW_MS): string {
  const bucket = Math.floor(now.getTime() / windowMs);
  return `${LEASE_PREFIX}tick-${bucket}.json`;
}

/**
 * Claim this window, or report that someone else has it.
 *
 * Fails *closed* on a store error: if we cannot tell whether another instance
 * holds the window, we do not settle. A missed pass costs an hour; a pass run
 * twice because the lease check errored costs money.
 */
export async function acquireTickLease(
  store: LeaseStore,
  options: { now?: Date; windowMs?: number; holder?: string } = {},
): Promise<{ acquired: boolean; key: string; reason?: string }> {
  const now = options.now ?? new Date();
  const windowMs = options.windowMs ?? DEFAULT_LEASE_WINDOW_MS;
  const key = leaseKeyFor(now, windowMs);

  const value: LeaseHolder = {
    holder: options.holder ?? 'campaign-agent',
    acquiredAt: now.toISOString(),
    windowMs,
  };

  try {
    const won = await store.putIfAbsent(key, JSON.stringify(value, null, 2));
    if (won) return { acquired: true, key };
    return { acquired: false, key, reason: 'another instance holds this window' };
  } catch (error) {
    return {
      acquired: false,
      key,
      reason: `lease store unavailable — refusing to settle: ${(error as Error).message}`,
    };
  }
}
