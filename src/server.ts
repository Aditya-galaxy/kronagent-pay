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
      return json({ ok: true, ...state() });
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
</style>
</head>
<body><div class="wrap">
  <h1>Kronagent Pay</h1>
  <p class="sub">An AI agent can already pay. Nothing decides whether it <em>should</em>.
  Every button below runs the real policy engine, mandates, rolling budget and hash-chained
  ledger — the same code path the live agent uses against Circle's Agent Stack.</p>

  <div class="grid">
    <div>
      <div class="panel">
        <h2>Run a scenario</h2>
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
