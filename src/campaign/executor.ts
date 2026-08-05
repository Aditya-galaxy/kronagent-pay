/**
 * Settlement, over the Circle CLI.
 *
 * A note on the rail, because the obvious guess is wrong and I made it.
 * Circle's Nanopayments — gas-free USDC down to $0.000001, batched through
 * Gateway — look like the natural fit for paying many creators small amounts.
 * They are not. `circle gateway` exposes exactly three verbs: `balance`,
 * `deposit`, `withdraw`. There is no send-to-address. A Gateway balance is
 * spent by `circle services pay <url>`, against **x402-protected endpoints**,
 * in a request/response cycle where the seller declares payment requirements
 * and the agent signs a payload. A creator is a person with a wallet address,
 * not an x402 seller, so none of that applies to a payout.
 *
 * Nanopayments belongs on the *other* side of this business: our own service is
 * 402-paywalled, so a brand's agent pays us over that rail. Money out to
 * creators is a plain `circle wallet transfer`, which costs gas per transfer.
 * That is also why payouts batch at dollar scale rather than trickling
 * per-view: at Base gas costs, settling a one-cent payout would spend a
 * meaningful fraction of it on the transfer.
 *
 * Two flags do real work here:
 *
 * **`--idempotency-key`** receives the intent id, which `tick.ts` derives as
 * `pay-<submission>-<confirmed views>`. That is deterministic, so a crash
 * between settling and persisting cannot pay the same views twice — the retry
 * presents the same key. This is the one window the tick could not close on
 * its own.
 *
 * **`--estimate`** is what dry-run uses. It exercises the real CLI, the real
 * wallet and the real chain and stops short of broadcasting, so a dry run
 * proves the path works rather than asserting it would.
 */

import type { PaymentOutcome } from '../schemas';
import type { Chain } from '../schemas';
import type { PayoutDecision } from './payout';
import type { Campaign, Creator } from './types';
import type { PayoutExecutor } from './tick';

/** Chain names as the CLI spells them. */
const CLI_CHAIN: Record<Chain, string> = {
  'base-sepolia': 'BASE-SEPOLIA',
  base: 'BASE',
  'eth-sepolia': 'ETH-SEPOLIA',
  ethereum: 'ETH',
  'polygon-amoy': 'MATIC-AMOY',
  polygon: 'MATIC',
};

/**
 * USDC contract per chain.
 *
 * Passed explicitly rather than omitted: `--token` defaults to the *native*
 * token, so leaving it off would send ETH instead of USDC. A payout that
 * silently moves the wrong asset is worse than one that fails.
 */
const USDC_TOKEN: Record<Chain, string> = {
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'eth-sepolia': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  'polygon-amoy': '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
};

const EXPLORER: Record<Chain, string> = {
  'base-sepolia': 'https://sepolia.basescan.org/tx/',
  base: 'https://basescan.org/tx/',
  'eth-sepolia': 'https://sepolia.etherscan.io/tx/',
  ethereum: 'https://etherscan.io/tx/',
  'polygon-amoy': 'https://amoy.polygonscan.com/tx/',
  polygon: 'https://polygonscan.com/tx/',
};

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected so tests never shell out and never need a funded wallet. */
export interface CommandRunner {
  run(args: string[]): Promise<CommandResult>;
}

export class BunCommandRunner implements CommandRunner {
  constructor(private readonly binary = 'circle') {}

  async run(args: string[]): Promise<CommandResult> {
    const proc = Bun.spawn([this.binary, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  }
}

export interface CircleExecutorOptions {
  /** The campaign wallet money leaves. */
  fromAddress: string;
  /** Plan and estimate, never broadcast. The default, deliberately. */
  dryRun?: boolean;
  runner?: CommandRunner;
}

/**
 * Pull a transaction hash out of the CLI's output.
 *
 * Tries JSON first and falls back to scanning for a hash, because `--quiet`
 * prints a bare hash for local wallets and a transaction *id* for agent
 * wallets. Returning nothing is a valid answer — a settlement whose hash we
 * cannot read still happened, and claiming a hash we did not find would be
 * worse than reporting none.
 */
export function extractTxHash(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['txHash', 'transactionHash', 'hash', 'transactionId', 'id']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  } catch {
    // Not JSON. Fall through to scanning.
  }
  return /\b(0x[a-fA-F0-9]{64})\b/.exec(trimmed)?.[1];
}

export class CircleCliExecutor implements PayoutExecutor {
  private readonly runner: CommandRunner;
  private readonly dryRun: boolean;

  constructor(private readonly options: CircleExecutorOptions) {
    this.runner = options.runner ?? new BunCommandRunner();
    this.dryRun = options.dryRun ?? true;
  }

  async send(input: {
    decision: PayoutDecision;
    creator: Creator;
    campaign: Campaign;
  }): Promise<PaymentOutcome> {
    const { decision, creator, campaign } = input;
    const chain = campaign.chain;
    const intentId = `pay-${decision.submissionId}-${decision.confirmedViews}`;
    const settledAt = new Date().toISOString();

    const args = [
      'wallet',
      'transfer',
      creator.payoutAddress,
      '--amount',
      decision.amountUsdc.toString(),
      '--token',
      USDC_TOKEN[chain],
      '--address',
      this.options.fromAddress,
      '--chain',
      CLI_CHAIN[chain],
      '--idempotency-key',
      intentId,
      '--output',
      'json',
    ];
    if (this.dryRun) args.push('--estimate');

    let result: CommandResult;
    try {
      result = await this.runner.run(args);
    } catch (error) {
      // The CLI missing entirely is a deployment fault, not a payout decision.
      return {
        intentId,
        executed: false,
        dryRun: this.dryRun,
        detail: 'could not run the Circle CLI',
        error: (error as Error).message,
        settledAt,
      };
    }

    if (result.code !== 0) {
      return {
        intentId,
        executed: false,
        dryRun: this.dryRun,
        detail: `circle wallet transfer exited ${result.code}`,
        error: (result.stderr || result.stdout).trim().slice(0, 500),
        settledAt,
      };
    }

    if (this.dryRun) {
      // Estimated, not sent. Reported as not executed so no payout is recorded
      // and no view is marked settled for money that never moved.
      return {
        intentId,
        executed: false,
        dryRun: true,
        detail:
          `estimated ${decision.amountUsdc} USDC to ${creator.payoutAddress} on ` +
          `${chain} — not broadcast`,
        settledAt,
      };
    }

    const txHash = extractTxHash(result.stdout);
    return {
      intentId,
      executed: true,
      dryRun: false,
      detail: `sent ${decision.amountUsdc} USDC to ${creator.payoutAddress} on ${chain}`,
      txHash,
      explorerUrl: txHash ? `${EXPLORER[chain]}${txHash}` : undefined,
      settledAt,
    };
  }
}
