# Kronagent Payouts

**You never pay for views that didn't survive.**

An autonomous agent that runs creator marketing campaigns end to end — reads the brief, judges each submitted clip against it, pulls real view counts, and settles in USDC under a ceiling it cannot raise.

Built on [Circle's Agent Stack](https://agents.circle.com/) for the **Build with Gemini XPRIZE** — category *Money & Financial Access*, opted in to the **Circle Agentic Economy Prize**.

---

## The problem

Brands pay creators per 1,000 views to clip and post their content. It is a real market: Content Rewards alone pays **over $40,000/day across ~1M videos a month** (Forbes, Apr 2026), for clients including Polymarket and ElevenLabs, and Whop settles roughly **$3B/year** in creator payouts.

It is also being drained. One brand documented paying **$1,500 for ~845,000 views that were "99.999% bot views"**. Multiple brands independently report view counts **clustering exactly at the maximum-payout cap** — not a coincidence, a calibrated attack.

The reason they lose the money is narrower than "fraud is hard":

> *"By the time a botted clip is caught, they have already paid for the views."*

**Payment happens before detection does.** That ordering is the whole bug.

## The mechanic

We do not try to out-detect a fraud ring. A platform with a fraud team and full telemetry is better placed to do that than we are, and every public account of this problem is a story about someone losing that arms race.

We changed what is being bought instead. **A view is payable once it has survived.**

```
confirmed = min(views_now, views_at_least_24h_ago)
payable   = confirmed − already_paid_for
amount    = payable × cpm ÷ 1000
```

- **Views still climbing** — the older, smaller number wins, so nothing pays until it sticks.
- **Views scrubbed by the platform** — the newer, smaller number wins, so inflation that got removed is never paid for.

The asymmetry is the point. Inflating a count costs an attacker nothing; keeping it inflated through the platform's own retro-scrubbing for a full day is materially harder — and it is the platform's fraud team doing that work, not ours.

**There is no clawback**, deliberately. Settled USDC cannot be recalled, so a falling count reduces the *next* payout to zero rather than pretending to reverse one. A system that claims otherwise is lying about its own guarantees.

## Why this is an agent, not a cron job

Three decisions require judgment, and each is gated:

| | |
|---|---|
| **Brief comprehension** | Gemini watches the clip and decides whether it satisfies a brief written in natural language. No rule expresses "does this show the product". |
| **Rate allocation** | The agent moves the CPM as the pool drains — but only inside a band the operator set. Out-of-band proposals are **refused, not clamped**: clamping would hand a prompt-injected agent the operator's ceiling, making overreach pay. |
| **Fraud investigation** | On anomalous view velocity the agent pulls more data before deciding. The investigation, not the threshold, is the agency. |

Underneath all three: **the model proposes, the engine disposes.** The agent can decide to pay $50. It cannot decide to pay $50 when the mandate says $10. A verdict is a *precondition* for payment, never a cause of it — and `PaymentIntent` structurally cannot express a disposition, with a test asserting no such field ever appears.

## The gate

Campaign checks run first, then delegate to a payment engine that is deterministic, first-match-wins, and fails closed.

| # | Check | Outcome |
|---|---|---|
| 1 | Unknown submission / campaign / creator | `blocked` |
| 2 | Past the agreed settlement deadline | `blocked` |
| 3 | No verdict, or the verdict failed | `blocked` |
| 4 | Nothing has survived the dwell period yet | `held` |
| 5 | No views beyond what was already paid | `no_op` |
| 6 | Would exceed the campaign pool | `blocked` |
| 7 | Over this creator's cap | `requires_approval` |
| 8 | → absolute cap · mandate · mandate cap · rolling window | |

Two choices worth explaining:

**The pool blocks rather than escalating.** Every other cap routes to a human, because a wrongly-held payment costs attention and a wrongly-sent one is irreversible. The pool is different in kind — "ask a human to approve exceeding the budget" is how a budget stops being one.

**The rolling window is a velocity limiter.** It bounds USDC per hour independently of pool size, so a compromised agent holding entirely valid mandates still cannot empty a large pool in an afternoon.

No LLM sits in this path. No network call. No configurable strictness. An agent that can be talked into *proposing* a payment is expected and survivable; an engine that can be talked into *approving* one is not.

## Terms are bilateral

Every control above protects the brand from the agent. Exactly one thing protects the **creator from the brand**, and without it this system reproduces the complaint it was built to answer — *"generating genuine views, and never being paid."*

Accepting a clip **copies** the campaign's rate, dwell and per-creator cap onto the submission. The payout path then reads those terms, never the live campaign. A brand may pause or end a campaign — that refuses *new* clips, at acceptance, before a creator has spent any effort. It does not abandon work already taken. The obligation ends at a settlement deadline, not at the brand's discretion.

What this cannot do is conjure money. If the pool empties, it empties — which is why **the remaining pool is published before a creator invests effort**. Disclosure is the honest control, not a promise we cannot keep. It is also the one thing a fiat rail structurally cannot offer.

## Where the money moves

```
brand's agent --x402/nanopayments--> our agent --wallet transfer--> creators
```

Nanopayments is right for the **revenue** leg: our own service is 402-paywalled, so a buying agent pays it in a single request/response cycle. It is *not* the payout rail — `circle gateway` exposes only `balance`, `deposit` and `withdraw`, and a Gateway balance is spent by `circle services pay <url>` against x402 endpoints. A creator is a person with a wallet address, not an x402 seller.

Payouts settle over `circle wallet transfer`. Two flags do real work: `--idempotency-key` receives the deterministic intent id `pay-<submission>-<views>`, which closes the crash-between-settling-and-persisting window; `--estimate` is what dry-run uses, so a dry run exercises the real CLI, wallet and chain and stops short of broadcasting.

## Status

| Component | State |
|---|---|
| Payout gate, dwell mechanic, rate band, terms, persistence, tick, executor | **Done** — 191 tests, typecheck clean |
| Gemini clip verifier | Blocked on `GOOGLE_API_KEY` |
| YouTube + X view oracles | Blocked on API keys |
| Real on-chain payout + Basescan proof | Blocked on Circle Terms acceptance |
| Cloud Run deployment | Ready — `./deploy.sh` |

```bash
bun install
bun test
bun run src/server.ts     # http://localhost:8080
```

**Scope, stated plainly.** YouTube and X only — Instagram, Facebook and TikTok need Meta/TikTok app review, which runs 2–6 weeks. We do not claim to detect bots better than anyone; we bound the damage and make every decision auditable. Payouts at scale are regulated, and this operates at demo scale.

## Pre-existing work, disclosed

Per the competition's *New Projects Only* requirement:

- **This project was created on 2026-08-04**, inside the submission period. Every line of source here is new.
- **[Circle Agent Stack starter kits](https://github.com/circlefin/agent-stack-starter-kits)** (Apache-2.0) — we build on the `google-adk` kit's tool definitions and its `ApprovalFn` seam. We replace its terminal-prompt approval implementation; we do not vendor its code.
- **[Kronagent](https://github.com/Aditya-galaxy/Kronagent)**, by the same author, is a cloud threat-defense platform with an earn-trust governance model for autonomous containment actions. **Its design informed this project** — the fail-closed policy ordering, expiring delegated authority, and hash-chained audit. **No code was copied**; this is an independent implementation in a different language for a different domain (irreversible payments rather than reversible containment).

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — threat model, invariants, the decision path, and an honest account of where the current implementation breaks at scale.

## License

**Source-available, not open source** — PolyForm Noncommercial 1.0.0, with an explicit **Competition Grant** on top. See [LICENSE](LICENSE).

You may read, study, fork and modify this for noncommercial purposes; commercial use needs a separate licence. The Competition Grant gives XPRIZE, Google, Circle, PHD Moonshots, Devpost, hacker.fund and their judges an irrevocable, royalty-free, unrestricted licence to run, host, test, evaluate and demonstrate this software for everything connected with the competition — satisfying the rules' *"free of charge and without any restriction"* requirement without making the work commercially free to everyone else.

The grant is stated explicitly because PolyForm's own permitted-use clauses cover charitable, educational, research, public-safety and government organizations — not the competition's commercial sponsors. Relying on interpretation there would have left an argument to have at judging time.
