/**
 * Durable campaign state.
 *
 * The dwell mechanic compares a view count now against one from at least a day
 * ago, which means it only works if yesterday outlived the process that
 * recorded it. On Cloud Run with `--min-instances 0` the instance dies within
 * minutes of going idle, so in-memory state is not a shortcut here — it would
 * make `hasDwelled()` permanently false and the anti-fraud mechanic would
 * silently never fire. Not a crash. Just a campaign that holds everything
 * forever and never says why.
 *
 * Two things get careful treatment.
 *
 * **Money and view counts never touch a JSON number.** `Decimal` is a bigint
 * of micro-USDC and views are bigint; both serialise as strings and parse back
 * exactly. Letting either become a double somewhere in the middle would
 * reintroduce, at the storage layer, precisely the class of bug `decimal.ts`
 * exists to prevent — and it would do it silently, on the way to disk, where no
 * arithmetic test would ever see it. A round-trip property test pins this.
 *
 * **A version tag is written and checked.** State that cannot be read is
 * refused rather than partially applied: a store half-populated from a format
 * we no longer understand would produce payout decisions from incomplete
 * history, which is the one failure mode worse than not starting.
 */

import { Decimal } from '../decimal';
import type { Campaign, Creator, Payout, Snapshot, Submission, Verdict } from './types';
import type { CampaignStore } from './store';

export const STATE_VERSION = 1;

/** A key/value blob store. The only thing the persistence layer needs. */
export interface BlobStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
}

type State = ReturnType<CampaignStore['exportState']>;

/** Money and counts as exact strings, never as JSON numbers. */
export function encodeState(state: State): string {
  return JSON.stringify(
    {
      version: STATE_VERSION,
      campaigns: state.campaigns.map((c) => ({
        ...c,
        poolUsdc: c.poolUsdc.toString(),
        cpmUsdc: c.cpmUsdc.toString(),
        perCreatorCapUsdc: c.perCreatorCapUsdc.toString(),
        rateBand: {
          minUsdc: c.rateBand.minUsdc.toString(),
          maxUsdc: c.rateBand.maxUsdc.toString(),
        },
      })),
      creators: state.creators,
      submissions: state.submissions,
      verdicts: state.verdicts,
      snapshots: state.snapshots.map((s) => ({ ...s, views: s.views.toString() })),
      payouts: state.payouts.map((p) => ({
        ...p,
        viewsPaidTo: p.viewsPaidTo.toString(),
        amountUsdc: p.amountUsdc.toString(),
      })),
    },
    null,
    2,
  );
}

export function decodeState(raw: string): State {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.version !== STATE_VERSION) {
    throw new RangeError(
      `campaign state is version ${String(parsed.version)}, this build reads ` +
        `${STATE_VERSION} — refusing to load rather than decide payouts from ` +
        'a history it only partly understands',
    );
  }

  const rows = <T>(key: string): T[] => (Array.isArray(parsed[key]) ? (parsed[key] as T[]) : []);

  return {
    campaigns: rows<Record<string, unknown>>('campaigns').map((c) => {
      const band = (c.rateBand ?? {}) as Record<string, string>;
      return {
        ...(c as unknown as Campaign),
        poolUsdc: new Decimal(String(c.poolUsdc)),
        cpmUsdc: new Decimal(String(c.cpmUsdc)),
        perCreatorCapUsdc: new Decimal(String(c.perCreatorCapUsdc)),
        rateBand: {
          minUsdc: new Decimal(String(band.minUsdc)),
          maxUsdc: new Decimal(String(band.maxUsdc)),
        },
      };
    }),
    creators: rows<Creator>('creators'),
    submissions: rows<Submission>('submissions'),
    verdicts: rows<Verdict>('verdicts'),
    snapshots: rows<Record<string, unknown>>('snapshots').map((s) => ({
      ...(s as unknown as Snapshot),
      views: BigInt(String(s.views)),
    })),
    payouts: rows<Record<string, unknown>>('payouts').map((p) => ({
      ...(p as unknown as Payout),
      viewsPaidTo: BigInt(String(p.viewsPaidTo)),
      amountUsdc: new Decimal(String(p.amountUsdc)),
    })),
  };
}

/** For tests, and for a single-process run that genuinely wants no durability. */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.blobs.get(key);
  }

  async put(key: string, value: string): Promise<void> {
    this.blobs.set(key, value);
  }
}

/** Local disk. What `bun run src/server.ts` uses. */
export class FileBlobStore implements BlobStore {
  constructor(private readonly directory: string) {}

  private path(key: string): string {
    return `${this.directory}/${key.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  }

  async get(key: string): Promise<string | undefined> {
    const file = Bun.file(this.path(key));
    return (await file.exists()) ? file.text() : undefined;
  }

  async put(key: string, value: string): Promise<void> {
    await Bun.write(this.path(key), value);
  }
}

/**
 * Cloud Storage, via the JSON API and the metadata server.
 *
 * Deliberately dependency-free: on Cloud Run the instance's own service
 * account token comes from the metadata server, so this needs no key file and
 * nothing to rotate. The token is cached until shortly before it expires
 * because every tick would otherwise pay a round-trip for it.
 */
export class GcsBlobStore implements BlobStore {
  private token?: { value: string; expiresAtMs: number };

  constructor(
    private readonly bucket: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAtMs > now + 60_000) return this.token.value;

    const response = await this.fetchImpl(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } },
    );
    if (!response.ok) throw new Error(`metadata server refused a token: ${response.status}`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: body.access_token,
      expiresAtMs: now + body.expires_in * 1000,
    };
    return this.token.value;
  }

  async get(key: string): Promise<string | undefined> {
    const token = await this.accessToken();
    const url =
      `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/` +
      `${encodeURIComponent(key)}?alt=media`;
    const response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    // A missing object is a first boot, not a failure.
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GCS read failed: ${response.status}`);
    return response.text();
  }

  async put(key: string, value: string): Promise<void> {
    const token = await this.accessToken();
    const url =
      `https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o` +
      `?uploadType=media&name=${encodeURIComponent(key)}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: value,
    });
    if (!response.ok) throw new Error(`GCS write failed: ${response.status}`);
  }
}

const STATE_KEY = 'campaign-state.json';

/**
 * Load state into a store on boot.
 *
 * A missing blob is a first run. A corrupt or wrong-version blob is not
 * survivable and throws, because starting with partial history means paying
 * out against view counts whose past we cannot see — the store would look
 * empty and every submission would read as never having been paid.
 */
export async function loadInto(store: CampaignStore, blobs: BlobStore): Promise<boolean> {
  const raw = await blobs.get(STATE_KEY);
  if (raw === undefined) return false;
  store.hydrate(decodeState(raw));
  return true;
}

export async function saveFrom(store: CampaignStore, blobs: BlobStore): Promise<void> {
  await blobs.put(STATE_KEY, encodeState(store.exportState()));
}
