/**
 * The judge-facing surface.
 *
 * The competition requires a working project anyone can test: *"Access must be
 * provided to an Entrant's working Project for judging and testing by
 * providing a link to a website, functioning demo, or a test build... free of
 * charge and without any restriction."* This is that link.
 *
 * It is not a mock. Every button runs the real `createPaymentGate` over the
 * real policy engine, mandates, budget and hash-chained ledger — the same code
 * path the live agent uses against Circle's Agent Stack. Only the price quote
 * is stubbed while no wallet is attached; swap the resolver and these become
 * real testnet payments with no other change.
 *
 * Deliberately dependency-free: Bun's built-in server, one file, HTML inline.
 * A judge's session should not be able to fail because of a build step, and
 * `bun run src/server.ts` is the whole deployment story on Cloud Run.
 */

import {
  budgetSnapshot,
  createDemoWorld,
  runScenario,
  SCENARIOS,
  type DemoWorld,
  type ScenarioName,
} from './scenarios';
import { isExpired } from './mandates';
import { runJob } from './business/loop';
import { MARKETPLACE } from './business/tools';
import { Decimal, USDC } from './decimal';
import { encodePayment, paymentRequiredBody, verifyPayment } from './x402';

/** What a customer pays for one answered question. Inputs come out of this. */
const JOB_PRICE_USDC = USDC('1.00');

/**
 * Where revenue lands. In production this is the Circle agent wallet address
 * from `circle wallet list`; the placeholder keeps the endpoint honest about
 * being unfunded rather than pretending otherwise.
 */
const RECEIVING_WALLET =
  process.env['AGENT_WALLET_ADDRESS'] ?? '0xAgentWalletNotYetProvisioned000000000000';

const x402Config = () => ({
  payTo: RECEIVING_WALLET,
  priceUsdc: JOB_PRICE_USDC,
  resource: '/api/job',
  description: 'One researched answer. The agent buys its sources on your behalf.',
});

/** Cumulative USDC received. The other half of the P&L. */
let revenue = new Decimal(0n);

const PORT = Number(process.env['PORT'] ?? 8080);

/**
 * One shared world, so a judge sees the budget deplete and the ledger grow
 * across clicks — the state is the point. `POST /api/reset` starts over.
 */
let world: DemoWorld = createDemoWorld();

function state() {
  return {
    mandates: world.mandates.list().map((m) => ({
      counterparty: m.counterparty,
      maxPerPaymentUsdc: m.maxPerPaymentUsdc.toString(),
      owner: m.owner,
      issuedBy: m.issuedBy,
      reason: m.reason,
      expiresAt: m.expiresAt ?? null,
      expired: isExpired(m),
      useCount: m.useCount,
      lastUsedAt: m.lastUsedAt ?? null,
    })),
    budget: budgetSnapshot(world),
    queue: world.queue.map((q) => ({
      counterparty: q.intent.counterparty,
      amountUsdc: q.intent.amountUsdc.toString(),
      reason: q.reason,
      purpose: q.intent.purpose ?? '',
    })),
    ledger: world.ledger.byStage('decision').map((r) => ({
      at: r.at,
      disposition: r.payload['disposition'],
      control: r.payload['control'],
      counterparty: r.payload['counterparty'],
      amountUsdc: r.payload['amountUsdc'],
      reason: r.payload['reason'],
      purpose: r.payload['purpose'],
    })),
    chain: world.ledger.verify(),
    // Both halves of the loop, so the console shows a P&L rather than a spend log.
    economics: {
      revenueUsdc: revenue.toString(),
      priceUsdc: JOB_PRICE_USDC.toString(),
      receivingWallet: RECEIVING_WALLET,
      walletProvisioned: !RECEIVING_WALLET.includes('NotYetProvisioned'),
    },
    scenarios: Object.entries(SCENARIOS).map(([name, s]) => ({
      name,
      title: s.title,
      narrative: s.narrative,
    })),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const server = Bun.serve({
  port: PORT,
  idleTimeout: 30,
  async fetch(request) {
    const url = new URL(request.url);

    // Cloud Run and any uptime check need a path that touches no state.
    if (url.pathname === '/healthz') return new Response('ok');

    if (url.pathname === '/api/state') return json(state());

    // The auditor's export: the whole chain, envelopes included, so anyone can
    // recompute the hashes themselves rather than take our word for it.
    if (url.pathname === '/api/ledger.jsonl') {
      return new Response(world.ledger.toJsonl(), {
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      });
    }

    if (url.pathname === '/api/reset' && request.method === 'POST') {
      world = createDemoWorld();
      revenue = new Decimal(0n);
      return json({ ok: true, ...state() });
    }

    // The live agent. A judge types a question; the agent plans, prices, buys
    // what it judges worth buying, and answers — every purchase routed through
    // the same gate the scripted scenarios use, against the same mandates.
    if (url.pathname === '/api/job' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { question?: string };
      const question = (body.question ?? '').trim();
      if (!question) return json({ error: 'a question is required' }, 400);

      // The receiving half. Our service is itself an x402 endpoint, so another
      // agent can discover it, pay it, and get an answer with no human on
      // either side of the transaction — which is what "agents autonomously
      // making *or receiving* payments" asks for.
      //
      // The console's own button pays with a demo authorization so a judge can
      // click through; a real buying agent presents a signed one and the same
      // verification runs either way.
      const paid = verifyPayment(request.headers.get('X-PAYMENT'), x402Config());
      if (!paid.ok) {
        return new Response(JSON.stringify(paymentRequiredBody(x402Config()), null, 2), {
          status: 402,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      revenue = revenue.plus(paid.proof.amountUsdc);
      world.ledger.append('settlement', {
        direction: 'received',
        payer: paid.proof.payer,
        amountUsdc: paid.proof.amountUsdc.toString(),
        txHash: paid.proof.txHash,
        resource: '/api/job',
      });

      const result = await runJob({
        question,
        buy: async (sourceUrl, price) => {
          const authorized = await world.gate('circle_pay_service', {
            url: sourceUrl,
            address: '0xagent00000000000000000000000000000000000',
            method: 'GET',
            dataJson: JSON.stringify({ question }),
          });
          if (!authorized) {
            // Surfaced back to the agent as the policy's own words, so its
            // next move is informed rather than a blind retry.
            throw new Error(world.queue.at(-1)?.reason ?? 'refused by the spend policy');
          }
          const source = MARKETPLACE.find((s) => s.url === sourceUrl);
          if (!source) throw new Error(`unknown source ${sourceUrl}`);
          return source.payload;
        },
      });

      const cogs = new Decimal(result.spentUsdc);
      return json({
        job: {
          ...result,
          // The unit economics of this one job. This is the line item that
          // makes it a business rather than a demo.
          priceUsdc: JOB_PRICE_USDC.toString(),
          cogsUsdc: cogs.toString(),
          marginUsdc: JOB_PRICE_USDC.minus(cogs).toString(),
        },
        ...state(),
      });
    }

    const scenarioMatch = url.pathname.match(/^\/api\/run\/([a-z]+)$/);
    if (scenarioMatch && request.method === 'POST') {
      const name = scenarioMatch[1] as ScenarioName;
      if (!(name in SCENARIOS)) return json({ error: `unknown scenario: ${name}` }, 404);
      const result = await runScenario(name, world);
      return json({ result, ...state() });
    }

    if (url.pathname === '/') {
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`kronagent-pay console on http://localhost:${server.port}`);

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kronagent Pay — governed autonomous payments</title>
<style>
  :root {
    --bg:#0b0f17; --panel:#121826; --border:#1f2937; --text:#e5e7eb;
    --muted:#8b98ad; --green:#10b981; --amber:#f59e0b; --red:#ef4444; --blue:#3b82f6;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.6 system-ui,-apple-system,sans-serif; }
  .wrap { max-width:1180px; margin:0 auto; padding:32px 20px 64px; }
  h1 { font-size:26px; margin:0 0 6px; letter-spacing:-.02em; }
  .sub { color:var(--muted); margin:0 0 28px; max-width:70ch; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
  @media (max-width:900px){ .grid { grid-template-columns:1fr; } }
  .panel { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:18px; }
  .panel h2 { font-size:13px; text-transform:uppercase; letter-spacing:.09em; color:var(--muted); margin:0 0 14px; }
  button { font:inherit; cursor:pointer; border-radius:8px; border:1px solid var(--border);
           background:#1b2436; color:var(--text); padding:10px 14px; text-align:left; width:100%; margin-bottom:8px; }
  button:hover { border-color:var(--blue); }
  button b { display:block; font-weight:600; }
  button span { color:var(--muted); font-size:13px; }
  .reset { width:auto; padding:6px 12px; font-size:13px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:var(--muted); font-weight:500; padding:6px 8px; border-bottom:1px solid var(--border); }
  td { padding:7px 8px; border-bottom:1px solid #161d2b; vertical-align:top; }
  code, .mono { font-family:var(--mono); font-size:12px; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; letter-spacing:.04em; }
  .paid { background:rgba(16,185,129,.15); color:var(--green); }
  .held { background:rgba(245,158,11,.15); color:var(--amber); }
  .blocked { background:rgba(239,68,68,.15); color:var(--red); }
  .muted { color:var(--muted); }
  .bar { height:8px; background:#1b2436; border-radius:99px; overflow:hidden; margin:8px 0 4px; }
  .bar div { height:100%; background:var(--green); }
  .chain-ok { color:var(--green); } .chain-bad { color:var(--red); }
  .narr { color:var(--muted); font-size:13px; margin:10px 0 0; }
  .ask { display:flex; gap:10px; }
  .ask input { flex:1; background:#0d1421; border:1px solid var(--border); border-radius:8px;
               color:var(--text); padding:10px 12px; font:inherit; }
  .ask input:focus { outline:none; border-color:var(--blue); }
  .econ { display:flex; gap:22px; margin:14px 0 10px; flex-wrap:wrap; }
  .econ div { font-size:12px; color:var(--muted); }
  .econ b { display:block; font-family:var(--mono); font-size:16px; color:var(--text); font-weight:600; }
  .econ .good b { color:var(--green); }
  .trace { font-family:var(--mono); font-size:12px; background:#0d1421; border:1px solid var(--border);
           border-radius:8px; padding:10px 12px; max-height:230px; overflow:auto; margin-top:10px; }
  .trace div { padding:2px 0; color:var(--muted); }
  .trace .paidline { color:var(--green); } .trace .refline { color:var(--amber); }
  .answer { background:#0d1421; border-left:3px solid var(--blue); border-radius:6px;
            padding:12px 14px; margin-top:12px; }
</style>
</head>
<body><div class="wrap">
  <h1>Kronagent Pay</h1>
  <p class="sub">An AI agent can already pay. Nothing decides whether it <em>should</em>.
  Every button below runs the real policy engine, mandates, rolling budget and hash-chained
  ledger — the same code path the live agent uses against Circle's Agent Stack.</p>

  <div class="panel" style="margin-bottom:20px">
    <h2>Ask the agent — it buys the data it needs</h2>
    <p class="narr" style="margin:0 0 12px">
      A customer question. The agent plans, searches the marketplace, decides what is worth its
      price, pays in USDC through the policy gate, and answers — with no human in the loop.
      It sells the answer for 1.00 USDC and buys its own inputs, so every job has a real margin.
    </p>
    <div class="ask">
      <input id="question" value="What are delivery conditions in NYC on Thursday?"
             placeholder="Ask the agent a question…">
      <button id="askbtn" class="reset" onclick="ask()" style="width:auto">Run job</button>
    </div>
    <div id="job"></div>
  </div>

  <div class="grid">
    <div>
      <div class="panel">
        <h2>Or run a scripted scenario</h2>
        <div id="scenarios"></div>
        <button class="reset" onclick="reset()">Reset state</button>
        <p class="narr" id="narrative"></p>
      </div>
      <div class="panel" style="margin-top:20px">
        <h2>Rolling budget</h2>
        <div id="budget"></div>
      </div>
      <div class="panel" style="margin-top:20px">
        <h2>Spend mandates</h2>
        <table id="mandates"></table>
      </div>
    </div>
    <div>
      <div class="panel">
        <h2>Decision ledger — refusals included</h2>
        <table id="ledger"></table>
        <p class="narr" id="chain"></p>
        <p class="narr"><a href="/api/ledger.jsonl" style="color:var(--blue)">Download the chain (JSONL)</a>
          — recompute the hashes yourself.</p>
      </div>
      <div class="panel" style="margin-top:20px">
        <h2>Waiting for a human</h2>
        <table id="queue"></table>
      </div>
    </div>
  </div>
</div>
<script>
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pill = d => d === 'auto_pay' ? '<span class="pill paid">PAID</span>'
  : d === 'blocked' ? '<span class="pill blocked">BLOCKED</span>'
  : '<span class="pill held">HELD</span>';

function render(s) {
  document.getElementById('scenarios').innerHTML = s.scenarios.map(x =>
    '<button onclick="run(\\'' + x.name + '\\')"><b>' + esc(x.title) + '</b></button>').join('');

  const b = s.budget, pct = Math.min(100, (parseFloat(b.spent) / parseFloat(b.cap)) * 100);
  document.getElementById('budget').innerHTML =
    '<div class="bar"><div style="width:' + pct + '%"></div></div>' +
    '<span class="mono">' + esc(b.spent) + ' / ' + esc(b.cap) + ' USDC</span> ' +
    '<span class="muted">spent in the rolling ' + esc(b.window) + ' window</span>';

  document.getElementById('mandates').innerHTML =
    '<tr><th>Counterparty</th><th>Cap</th><th>Owner</th><th>Used</th></tr>' +
    s.mandates.map(m => '<tr><td><code>' + esc(m.counterparty.replace(/^https?:\\/\\//,'')) + '</code>'
      + '<div class="muted">' + esc(m.reason) + '</div></td>'
      + '<td class="mono">' + esc(m.maxPerPaymentUsdc) + '</td>'
      + '<td>' + esc(m.owner) + (m.expired ? ' <span class="pill blocked">EXPIRED</span>' : '') + '</td>'
      + '<td class="mono">' + m.useCount + '&times;</td></tr>').join('');

  document.getElementById('ledger').innerHTML = s.ledger.length === 0
    ? '<tr><td class="muted">No decisions yet — run a scenario.</td></tr>'
    : '<tr><th></th><th>Counterparty</th><th>Amount</th><th>Why</th></tr>' +
      s.ledger.slice().reverse().map(r => '<tr><td>' + pill(r.disposition) + '</td>'
        + '<td><code>' + esc(String(r.counterparty).replace(/^https?:\\/\\//,'')) + '</code></td>'
        + '<td class="mono">' + esc(r.amountUsdc) + '</td>'
        + '<td class="muted">' + esc(r.reason) + '</td></tr>').join('');

  document.getElementById('chain').innerHTML = s.chain.ok
    ? '<span class="chain-ok">Hash chain verifies end to end.</span>'
    : '<span class="chain-bad">Chain broken at entry ' + s.chain.brokenAt + '.</span>';

  document.getElementById('queue').innerHTML = s.queue.length === 0
    ? '<tr><td class="muted">Nothing waiting. Nobody was interrupted.</td></tr>'
    : '<tr><th>Counterparty</th><th>Amount</th><th>Held because</th></tr>' +
      s.queue.map(q => '<tr><td><code>' + esc(q.counterparty.replace(/^https?:\\/\\//,'')) + '</code></td>'
        + '<td class="mono">' + esc(q.amountUsdc) + '</td>'
        + '<td class="muted">' + esc(q.reason) + '</td></tr>').join('');
}

function renderJob(j) {
  const traceLine = s => {
    const cls = s.event === 'buy_data.paid' ? 'paidline' : s.event === 'buy_data.refused' ? 'refline' : '';
    return '<div class="' + cls + '">' + esc(s.event) + '  ' + esc(JSON.stringify(s.detail).slice(0,150)) + '</div>';
  };
  document.getElementById('job').innerHTML =
    '<div class="econ">'
    + '<div>SOLD FOR<b>' + esc(j.priceUsdc) + '</b></div>'
    + '<div>INPUTS COST<b>' + esc(j.cogsUsdc) + '</b></div>'
    + '<div class="good">MARGIN<b>' + esc(j.marginUsdc) + '</b></div>'
    + '<div>SOURCES BOUGHT<b>' + j.purchases.length + '</b></div>'
    + '<div>REFUSED<b>' + j.refusals.length + '</b></div>'
    + '<div>MODEL<b style="font-size:12px">' + esc(j.model) + '</b></div>'
    + '</div>'
    + '<div class="answer"><strong>Answer</strong> <span class="muted">(' + esc(j.confidence) + ' confidence)</span><br>' + esc(j.answer) + '</div>'
    + '<div class="trace">' + j.steps.map(traceLine).join('') + '</div>';
}

async function ask() {
  const btn = document.getElementById('askbtn');
  btn.disabled = true; btn.textContent = 'Agent working…';
  document.getElementById('narrative').textContent = '';
  try {
    const question = document.getElementById('question').value;
    const call = (headers) => fetch('/api/job', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ question }),
    });

    // The x402 handshake, exactly as a buying agent performs it: ask, receive
    // 402 Payment Required with the terms, pay, retry with X-PAYMENT.
    let res = await call({});
    if (res.status === 402) {
      const terms = (await res.json()).accepts[0];
      const authorization = btoa(JSON.stringify({
        amount: terms.maxAmountRequired,
        network: terms.network,
        payTo: terms.payTo,
        payer: '0xConsoleBuyer',
        txHash: 'demo-console-authorization',
      }));
      res = await call({ 'X-PAYMENT': authorization });
    }
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    renderJob(data.job);
    render(data);
  } finally { btn.disabled = false; btn.textContent = 'Run job'; }
}

async function run(name) {
  const res = await fetch('/api/run/' + name, { method:'POST' });
  const data = await res.json();
  document.getElementById('narrative').textContent = data.result.narrative;
  render(data);
}
async function reset() {
  const data = await (await fetch('/api/reset', { method:'POST' })).json();
  document.getElementById('narrative').textContent = '';
  render(data);
}
fetch('/api/state').then(r => r.json()).then(render);
</script>
</body></html>`;
