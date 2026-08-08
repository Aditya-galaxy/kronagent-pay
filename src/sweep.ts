/**
 * The simulation sweep, as a command.
 *
 * This existed only as a function `sweep()` with no way to invoke it, while
 * the public testing page printed a transcript of `bun run sweep` and the
 * figures it produced. Anyone checking the strongest claim on that page —
 * on a page whose whole argument is "proven, not sampled" — got
 * `error: Script not found`.
 *
 * The numbers are now whatever this prints, because this is what a reader can
 * run.
 */

import { sweep } from './simulation';

const seeds = Number(Bun.argv[2] ?? 200);
const started = performance.now();
const out = sweep(seeds);
const wall = (performance.now() - started) / 1000;

const years = out.simulatedDays / 365.25;
console.log(`runs           ${out.runs} seeds`);
console.log(`decisions      ${out.totalSteps.toLocaleString('en-US')}`);
console.log(`simulated time ${years.toFixed(1)} years`);
console.log(`wall clock     ${wall.toFixed(1)}s`);
console.log(`violations     ${out.firstFailure ? 'FOUND' : 'none'}`);

if (out.firstFailure) {
  // Exit non-zero: a sweep that finds a violation and returns success is a
  // sweep nobody can put in CI.
  console.error(`\nfirst failure on seed ${out.firstFailure.seed}:`);
  for (const v of out.firstFailure.violations) console.error(`  ${JSON.stringify(v)}`);
  process.exit(1);
}
