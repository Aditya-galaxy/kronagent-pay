# Kronagent Pay

**An AI agent can already pay. Nothing decides whether it should.**

Built on [Circle's Agent Stack](https://agents.circle.com/) for the **Build with Gemini XPRIZE** — category *Money & Financial Access*, opted in to the **Circle Agentic Economy Prize**.

---

## The problem, stated precisely

Circle's Agent Stack solves *how* an agent pays: an agent wallet, USDC, x402, sub-cent nanopayments. That part works, and it works well.

What it does not solve is *whether a given payment should happen*. Circle's own starter kits answer that with a terminal prompt:

```
approval required for tool: circle_pay_service
{ "url": "...", "address": "0x..." }
Approve this action? [y/N]
```

A human presses `y`. Every time. That is a confirm dialog, not autonomy:

- it cannot run unattended, which is the entire point of an agent;
- it leaves no record beyond terminal scrollback;
- it gives an operator no way to say *"payments under five cents to this service are fine for the next thirty days"*;
- and Circle's own prize rules exclude it — *"the payment must be genuinely agent-driven — a human manually completing checkout does not qualify."*

Meanwhile `circle wallet limit`, Circle's native spending policy, is **mainnet-only** (*"testnets not supported"*) and its `set` requires a human OTP. It is a per-wallet knob with no owner, no expiry, no stated reason, no audit trail, and no path for the payment it refuses.

**Kronagent Pay is the layer in between.** The operator issues *mandates* in advance; the agent then transacts unattended within them, and every decision — including every refusal — lands on a hash-chained ledger.

## How it works

The integration is one function. Circle's kits expose exactly one seam for spend control:

```ts
type ApprovalFn = (toolName: string, args: unknown) => Promise<boolean>;
```

wired into the ADK's `beforeToolCallback` (LangChain's `interruptOn`, the Claude Agent SDK's `canUseTool` — same idea, three frameworks). Circle implements it as the `y/N` prompt. We implement it as a policy decision:

```ts
const agent = buildAgent(config, createPaymentGate({
  engine, mandates, budget, ledger, resolvePrice, approvals,
}), ask);
```

### The decision

Deterministic, first-match-wins, nothing fails open:

| # | Check | Outcome |
|---|---|---|
| 1 | Kill switch engaged | `blocked` |
| 2 | Mainnet, not explicitly armed | `blocked` |
| 3 | Over the absolute per-payment ceiling | `requires_approval` |
| 4 | No live mandate for the counterparty | `requires_approval` |
| 5 | Over that mandate's per-payment cap | `requires_approval` |
| 6 | Would breach the rolling window budget | `requires_approval` |
| 7 | Otherwise | `auto_pay` |

No LLM sits in this path. No network call. No configurable strictness. The verdict cannot be influenced by a web page the agent read or a merchant's response body — because **an agent that can be talked into *proposing* a payment is expected and survivable; an engine that can be talked into *approving* one is not.**

`PaymentIntent` structurally cannot express a disposition: there is no `approved` field for a model to fill in, and a test asserts none ever appears.

### Pricing precedes authorizing

`circle_pay_service` takes a URL and **no amount** — the price comes from the service's own x402 requirements. So the gate resolves the price itself rather than trusting a number the agent supplied, because the agent read the service listing and the listing is attacker-influenced input.

If pricing fails, the payment is held. *"The price lookup failed so we paid anyway"* is not a sentence anyone wants in an incident review.

### Mandates

A mandate is an operator saying, on the record: *this agent may pay this counterparty, up to this much per payment, until this date, and I am accountable for it.*

- **It expires.** A periodic review fails open — silence reads as approval. An expiry fails closed: authority lapses unless a named person renews it, so inattention withdraws spending power instead of extending it.
- **It has an owner, distinct from its issuer.** The issuer made a decision on a date that nothing later changes; the owner is who is accountable *now*. People change teams; the decision they made in March does not.
- **It is per-counterparty.** An agent with a $10 daily budget and no counterparty restriction can send $10 to an attacker.
- **It records why**, verbatim — six months on, that sentence is the only thing that can answer *"should this still exist?"*

### Defence in depth

Our engine decides the amount, then passes it to Circle's CLI as `--max-amount`, which independently refuses to exceed it. **Two systems have to agree before USDC moves, and the second one isn't ours.**

## Status

| Component | State |
|---|---|
| Policy engine, mandates, budget, ledger, gate | Done — 34 tests, typecheck clean |
| Live testnet payment + Basescan proof | In progress |
| Governance console on Cloud Run | In progress |

```bash
bun install
bun test
```

## Pre-existing work, disclosed

Per the competition's *New Projects Only* requirement:

- **This project was created on 2026-08-04**, inside the submission period. Every line of source here is new.
- **[Circle Agent Stack starter kits](https://github.com/circlefin/agent-stack-starter-kits)** (Apache-2.0) — we build on the `google-adk` kit's tool definitions and its `ApprovalFn` seam. We replace its terminal-prompt approval implementation; we do not vendor its code.
- **[Kronagent](https://github.com/Aditya-galaxy/Kronagent)**, by the same author, is a cloud threat-defense platform with an earn-trust governance model for autonomous containment actions. **Its design informed this project — the fail-closed policy ordering, expiring delegated authority, and hash-chained audit. No code was copied**; this is an independent implementation in a different language for a different domain (irreversible payments rather than reversible containment).

## License

MIT — see [LICENSE](LICENSE). Deliberately permissive so judges can test *"free of charge and without any restriction"* as the rules require.
