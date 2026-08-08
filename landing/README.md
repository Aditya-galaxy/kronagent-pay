# merlinclips.com

Four static pages, one stylesheet, zero external requests — no fonts, no
analytics, no CDN. Nothing we do not control can slow it down or block it.

    /                  the pitch, the incident, the dwell mechanic
    /architecture      where the decision lives, and what breaks at scale
    /security          threat model, attacks in scope, the 21 invariants
    /testing           property tests, deterministic simulation, defects found

The stale-content warning that stood here is resolved: all four pages now
describe the campaign payout agent rather than the spend limiter that preceded
it, and the `$1 claim` section and its Polar checkout are gone. There is
nothing to sell on this site yet, deliberately — every call to action points
at something a reader can verify, which is the only thing we currently have
worth their attention.

## Claims on these pages are checkable, and must stay that way

The numbers on `/testing` come from `bun run sweep` in the repo root. That page
previously printed a transcript of a command that **did not exist**, which is
the worst possible defect on a page arguing "proven, not sampled". If the
simulation changes, re-run it and update the figures rather than letting them
drift:

```bash
bun run sweep
```

The invariant table on `/security` must match `ARCHITECTURE.md`. They are
maintained by hand in two places, so they will diverge eventually — the count
is the cheap thing to check:

```bash
grep -cE '^\| \*\*I[0-9]+\*\*' ../ARCHITECTURE.md
grep -coE '<td class="mono">I[0-9]+</td>' security.html
```

## Local preview

The pages use absolute paths (`/styles.css`), so opening the files directly
will not load styles. Serve the directory instead:

```bash
python3 -m http.server 4173 --directory landing
```

## Deploy

```bash
npx vercel --prod
```

Then in Spaceship DNS for merlinclips.com, point the records at Vercel. Wait
for the certificate to issue before sharing the link.
