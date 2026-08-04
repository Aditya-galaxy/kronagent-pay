# Architecture

> The whole design falls out of one refusal: **we will not move money we did
> not mean to, and we will not move it twice.**

This document states the threat model, the invariants the system must hold, the
current design, and — deliberately — the places where the current design would
break at scale and what replaces them. A design document that only describes
what works is marketing.

---

## 1. Threat model

The agent is **not** trusted. That is the founding assumption, and everything
else follows from it.

An LLM-driven purchasing agent reads marketplace listings, service
descriptions, API responses and web pages. All of that is text written by
someone else. A sufficiently well-crafted listing will convince a model to
propose paying an attacker, and no amount of prompt engineering makes that
reliably false — treating "the model won't fall for it" as a control is the
mistake this system exists to avoid.

| Actor | Trusted? | Why |
|---|---|---|
| The operator issuing mandates | Yes | Authenticated human; their intent *is* the policy |
| The policy engine | Yes | Deterministic, reads no attacker-controlled input |
| The Gemini agent | **No** | Reads attacker-influenced text; can be induced to propose anything |
| Marketplace listings, 402 responses | **No** | Written by counterparties |
| Circle's CLI / Agent Stack | Partially | Trusted to execute correctly; not trusted as our only control |

**Attacks in scope**

1. *Prompt injection → payment redirection.* A listing instructs the agent to
   pay an attacker address.
2. *Price manipulation.* A mandated seller quotes 500 USDC for a one-cent
   endpoint, or the agent is induced to accept an inflated quote.
3. *Drain by attrition.* Thousands of individually-legal nanopayments. This is
   the attack the nanopayment model makes natural, and per-payment caps do
   nothing against it.
4. *Authority sprawl.* Mandates accumulate, nobody revokes them, and the
   blast radius grows silently over months.
5. *Replay / double execution.* A retried request pays twice.

**Explicitly out of scope:** compromise of the operator's Circle credentials,
compromise of the host, and malicious code in our own dependencies. Those are
real, and this system does not claim to defend against them.

---

## 2. Invariants

These are the promises. Each is enforced in code and asserted by
property-based tests over generated inputs (`src/policy.properties.test.ts`),
not merely by chosen examples.

| # | Invariant |
|---|---|
| **I1** | No payment above the absolute per-payment ceiling is ever authorized — no mandate can raise it |
| **I2** | No payment to a counterparty without a live mandate is ever authorized |
| **I3** | No mainnet payment is authorized unless mainnet is explicitly armed |
| **I4** | The kill switch admits no exceptions |
| **I5** | An expired mandate authorizes nothing, at any time after expiry |
| **I6** | Total authorized spend in a window never exceeds the window cap |
| **I7** | `decide()` is total — it never throws, for any input |
| **I8** | `decide()` is deterministic — same inputs, same verdict |
| **I9** | Policy is monotonic — tightening a limit never authorizes something the looser limit refused |
| **I10** | Every decision names the control that produced it |

I7 deserves a note: a policy engine that can throw is a policy engine that can
be made to fail *open* by whoever catches the exception. Totality is a safety
property, not a robustness nicety.

I9 is about operability rather than security. Non-monotonic policy is
unreasonable to run — an operator tightening a cap would have no way to reason
about what they just changed.

---

## 3. Decision path

```
 Gemini agent                    ← untrusted; reads attacker-controlled text
      │  proposes: "pay https://service.example"
      ▼
 beforeToolCallback  ──────────► the single seam Circle's kits expose
      │
      ▼
 Price resolution                ← `circle services pay --estimate`
      │  we price it; we never trust an amount the agent supplied
      ▼
 Policy engine                   ← deterministic, reads no untrusted input
      │  mandates · caps · rolling budget · kill switch
      ├─── auto_pay ────────────► reserve budget → execute → settle
      ├─── requires_approval ───► approval queue (a human decides)
      └─── blocked ─────────────► refused outright
                 │
                 ▼
        Hash-chained ledger       ← every decision, refusals included
```

**Pricing precedes authorizing.** `circle_pay_service` takes a URL and no
amount; the price comes from the service's own x402 response. So the gate
resolves the price itself. You cannot authorize what you have not priced, and
if pricing fails the payment is held — *"the price lookup failed so we paid
anyway"* is not a sentence anyone wants in an incident review.

**Defence in depth.** The authorized amount is passed to Circle's CLI as
`--max-amount`, which independently refuses to exceed it. Two systems must
agree before USDC moves, and the second one isn't ours.

---

## 4. What the current implementation is, honestly

The build today is a **single-process, in-memory** system. Every invariant
above holds *within one process*, which is enough for the demo, the judging
console, and a single-tenant agent — and is not enough for production.

JavaScript's single-threaded execution is doing real work here: `decide()` and
`budget.record()` are synchronous with no `await` between them, so the
read-then-write is atomic and no two concurrent gate calls can both observe the
pre-spend total. That is a genuine guarantee, and it evaporates the moment
there is more than one process.

### Where it breaks at scale

| Gap | Consequence | Severity |
|---|---|---|
| State in memory | Cloud Run scales to N instances → **N × the budget**. Two instances mean twice the spend ceiling, silently | **Critical** |
| No durability | A restart forgets every mandate, budget consumption and ledger entry | **Critical** |
| Single-writer hash chain | Concurrent appends from two instances produce a chain that cannot verify | High |
| No idempotency key | A retried intent consumes budget twice | High |
| Budget consumed at authorization, never released | A payment that fails after authorization starves the agent permanently | Medium |
| Wall-clock expiry | Skew between instances shifts mandate expiry by the skew | Low |

The demo pins `max-instances` low and scales to zero, so the multi-instance
gap is not *live* — but it is a property of the deployment configuration, not
of the design, and configuration is exactly the wrong place for a safety
property to live.

---

## 5. The production design

### 5.1 Durable state, per-agent sharding

Mandates, budget consumption and the ledger move to a transactional store
(Postgres / Cloud SQL, or Firestore with transactions). The budget check and
its consumption must be a **single atomic transaction** — read-then-write
across a network is a textbook TOCTOU, and the thing being raced is a spend
ceiling.

Serialize per `agentId` rather than globally. Global locks are the standard way
to make a payment system that is correct and unusable; per-agent serialization
gives correctness where it is needed and parallelism everywhere else.

### 5.2 Reservation, not deduction

Two-phase, so a failed payment does not permanently consume budget:

```
reserve(intentId, amount)   → row: state=reserved, expires_at=now+5m
   ↓ execute via Circle
commit(intentId, txHash)    → state=settled
   or
release(intentId, reason)   → state=released, budget returned
   or
(reservation lapses)        → swept back after 5 minutes
```

The lapse sweep matters: a process that dies between `reserve` and
`commit` must not strand budget forever. Reservations expire; deductions
don't.

### 5.3 Idempotency

Every intent carries a client-generated key. `reserve` is
`INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *` — a retry
returns the original reservation rather than creating a second one. This is
the industry-standard defence and there is no reason to invent a different one.

### 5.4 Ledger under concurrency

A hash chain has a single-writer assumption baked in: entry *n* hashes entry
*n−1*, so two concurrent appends both claim the same predecessor and the chain
forks.

Two options, in preference order:

1. **Per-agent chains.** Each agent's ledger is its own chain, appended under
   the same per-agent lock as the budget. Verification is per-agent, which is
   also how an auditor reads it. Preferred.
2. **A sequencer.** A single writer assigns positions. Correct, and a
   bottleneck and a single point of failure.

Entries are append-only and never updated — balances are derived by summing
history, never by mutating a row. The chain gives tamper-*evidence*; write
access to the store still permits truncation, and claiming otherwise would be
dishonest.

### 5.5 Failure posture

Every dependency failure resolves toward *not paying*:

| Failure | Behaviour |
|---|---|
| Price resolution fails | Hold for approval |
| Mandate store unreachable | Hold — an unreadable mandate is not a mandate |
| Ledger write fails | **Refuse.** A payment we cannot record is a payment we do not make |
| Gemini unavailable | Agent degrades; the gate is unaffected because it never consulted the model |
| Circle CLI errors | Release the reservation, record the failure |

The ledger rule is the one people push back on. It is deliberate: the audit
trail is the product. A payment that executed with no record of why is
precisely the outcome this system exists to prevent, and it is worse than a
missed payment.

---

## 6. Testing strategy

**Example tests** (`*.test.ts`) cover the cases we thought of — the happy path,
each refusal control, the seam against Circle's real tool signatures.

**Property tests** (`policy.properties.test.ts`) cover the ones we didn't.
Every invariant in §2 is asserted over thousands of generated intents and
settings; fast-check shrinks any counterexample to a minimal reproduction.
Currently ~11,600 assertions per run.

**What is deliberately not mocked:** the policy engine, mandates, budget and
ledger are the real implementations everywhere, including in the demo console.
The only stub is the price quote, standing in for `circle services pay
--estimate` when no wallet is attached — swapping that resolver turns the same
code path into real testnet payments.

**Still to add**, and named rather than glossed:

- Concurrency tests against the durable store, once it exists — the current
  guarantee rests on single-threaded execution and needs re-proving under
  transactions.
- Fault injection: kill the process between `reserve` and `commit`, assert the
  reservation lapses and budget returns.
- Chain verification under concurrent append, per §5.4.

---

## 7. Why the deterministic core is small

The policy engine is a few hundred lines, has no dependencies, makes no network
calls, and reads nothing an attacker can write. That is not minimalism for its
own sake — it is the part that has to be *audited*, and every line in it is a
line someone must be willing to defend when a payment goes wrong.

Everything sophisticated in this system — the model, the marketplace
discovery, the x402 handshake, the chain settlement — sits *outside* that
boundary, where it can fail, be manipulated, or be replaced without touching
the code that decides whether money moves.
