/**
 * Settlement over the Circle CLI.
 *
 * The tests worth having are the ones about what gets sent and what happens
 * when it doesn't: the token address must be explicit or the transfer moves
 * ETH instead of USDC, and every failure must report `executed: false` so the
 * tick never records a payout for money that stayed put.
 */

import { describe, expect, test } from 'bun:test';

import { Decimal } from '../decimal';
import { CircleCliExecutor, extractTxHash, idempotencyUuid, type CommandRunner } from './executor';
import type { PayoutDecision } from './payout';
import type { Campaign, Creator } from './types';

const CREATOR: Creator = { creatorId: 'cre-1', payoutAddress: '0xdest', handles: {} };

const campaign = (chain: Campaign['chain'] = 'base-sepolia'): Campaign => ({
  campaignId: 'camp-1',
  brief: 'brief',
  poolUsdc: new Decimal('100'),
  cpmUsdc: new Decimal('1'),
  rateBand: { minUsdc: new Decimal('0.5'), maxUsdc: new Decimal('2') },
  perCreatorCapUsdc: new Decimal('10'),
  dwellMs: 86_400_000,
  settlementWindowMs: 14 * 86_400_000,
  platforms: ['youtube'],
  chain,
  status: 'active',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
});

const DECISION = {
  submissionId: 'sub-1',
  campaignId: 'camp-1',
  creatorId: 'cre-1',
  disposition: 'auto_pay',
  control: 'mandated',
  reason: 'within caps',
  confirmedViews: 2_000n,
  payableViews: 2_000n,
  amountUsdc: new Decimal('2'),
  decidedAt: '2026-08-05T12:00:00.000Z',
} as unknown as PayoutDecision;

/** Captures the argv the executor would run, and replies with `reply`. */
function spy(reply: Partial<{ code: number; stdout: string; stderr: string }> = {}) {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(args) {
      calls.push(args);
      return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
    },
  };
  return { calls, runner };
}

const send = (executor: CircleCliExecutor, chain: Campaign['chain'] = 'base-sepolia') =>
  executor.send({ decision: DECISION, creator: CREATOR, campaign: campaign(chain) });

describe('the command it builds', () => {
  test('the USDC token is passed explicitly, not left to default', async () => {
    // --token defaults to the *native* token, so omitting it would send ETH.
    const { calls, runner } = spy();
    await send(new CircleCliExecutor({ fromAddress: '0xfrom', dryRun: false, runner }));
    const args = calls[0]!;
    expect(args.slice(0, 3)).toEqual(['wallet', 'transfer', '0xdest']);
    expect(args[args.indexOf('--token') + 1]).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(args[args.indexOf('--amount') + 1]).toBe('2');
    expect(args[args.indexOf('--chain') + 1]).toBe('BASE-SEPOLIA');
    expect(args[args.indexOf('--address') + 1]).toBe('0xfrom');
  });

  test('the idempotency key is a UUID, not the raw intent id', async () => {
    // Circle rejects a non-UUID with `400 Invalid request body`. Passing the
    // readable intent id straight through silently disabled the guarantee the
    // flag exists for — every settlement failed, and idempotency with it.
    const { calls, runner } = spy();
    await send(new CircleCliExecutor({ fromAddress: '0xfrom', dryRun: false, runner }));
    const args = calls[0]!;
    const key = args[args.indexOf('--idempotency-key') + 1]!;
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(key).not.toBe('pay-sub-1-2000');
  });

  test('the same payout always produces the same key, a different one does not', async () => {
    // Determinism is the whole point — a random UUID would satisfy the format
    // and destroy the property. Verified live: replaying an identical payout
    // returned the same tx hash rather than sending twice.
    expect(idempotencyUuid('pay-sub-1-2000')).toBe(idempotencyUuid('pay-sub-1-2000'));
    expect(idempotencyUuid('pay-sub-1-2000')).not.toBe(idempotencyUuid('pay-sub-1-2001'));
    expect(idempotencyUuid('pay-sub-1-2000')).not.toBe(idempotencyUuid('pay-sub-2-2000'));
  });

  test('mainnet uses the mainnet token and explorer', async () => {
    const { calls, runner } = spy({ stdout: '{"txHash":"0xabc"}' });
    const outcome = await send(
      new CircleCliExecutor({ fromAddress: '0xfrom', dryRun: false, runner }),
      'base',
    );
    expect(calls[0]![calls[0]!.indexOf('--token') + 1]).toBe(
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    );
    expect(outcome.explorerUrl).toBe('https://basescan.org/tx/0xabc');
  });
});

describe('dry run', () => {
  test('estimates against the real CLI and does not claim to have executed', async () => {
    const { calls, runner } = spy();
    const outcome = await send(new CircleCliExecutor({ fromAddress: '0xfrom', runner }));
    expect(calls[0]).toContain('--estimate');
    expect(outcome.executed).toBe(false);
    expect(outcome.dryRun).toBe(true);
    expect(outcome.detail).toContain('not broadcast');
  });

  test('dry run is the default — a missing flag never spends real money', async () => {
    const { calls, runner } = spy();
    await send(new CircleCliExecutor({ fromAddress: '0xfrom', runner }));
    expect(calls[0]).toContain('--estimate');
  });
});

describe('when settlement fails', () => {
  test('a non-zero exit reports not executed, with the CLI error kept', async () => {
    const { runner } = spy({ code: 1, stderr: 'insufficient USDC balance' });
    const outcome = await send(new CircleCliExecutor({ fromAddress: '0xfrom', dryRun: false, runner }));
    expect(outcome.executed).toBe(false);
    expect(outcome.error).toContain('insufficient USDC balance');
  });

  test('a missing CLI is a deployment fault, not a silent success', async () => {
    const broken: CommandRunner = {
      async run() {
        throw new Error('circle: command not found');
      },
    };
    const outcome = await send(
      new CircleCliExecutor({ fromAddress: '0xfrom', dryRun: false, runner: broken }),
    );
    expect(outcome.executed).toBe(false);
    expect(outcome.error).toContain('command not found');
  });
});

describe('reading the receipt', () => {
  test('a hash is read from JSON output', () => {
    expect(extractTxHash('{"txHash":"0xdead"}')).toBe('0xdead');
    expect(extractTxHash('{"transactionId":"tx-123"}')).toBe('tx-123');
  });

  test('a bare hash from --quiet is read too', () => {
    const hash = `0x${'a'.repeat(64)}`;
    expect(extractTxHash(`\n${hash}\n`)).toBe(hash);
  });

  test('no hash is reported as none rather than invented', () => {
    // The transfer still happened; claiming a hash we did not find would be
    // worse than admitting we have none.
    expect(extractTxHash('Transfer submitted.')).toBeUndefined();
  });

  test('a successful send carries the explorer URL the rules ask for', async () => {
    const hash = `0x${'b'.repeat(64)}`;
    const { runner } = spy({ stdout: hash });
    const outcome = await send(new CircleCliExecutor({ fromAddress: '0xfrom', dryRun: false, runner }));
    expect(outcome.executed).toBe(true);
    expect(outcome.txHash).toBe(hash);
    expect(outcome.explorerUrl).toBe(`https://sepolia.basescan.org/tx/${hash}`);
  });
});
