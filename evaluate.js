#!/usr/bin/env node
/* Evaluate MediCore's escalation policy.
 *
 * Question: how often does the escalation layer send a case to a human too late
 * (a fraud-flagged claim is auto-approved) or too early (a clean claim is escalated)?
 *
 * Ground truth: the dataset's Fraud_Flag, used as a proxy for "a person should review this".
 * Reference statistics are computed leave-one-out, so a claim never influences its own check.
 *
 * Usage:
 *   node eval/evaluate.js                         rules-only, on the bundled 69-record sample
 *   node eval/evaluate.js --csv data/full.csv     rules-only, on the full dataset
 *   node eval/evaluate.js --llm --api http://localhost:3000   agents + rules via the Gemini backend
 *   node eval/evaluate.js --ollama qwen2.5:3b     agents + rules via a local Ollama model (free, no key)
 *                                                 (--ollama-url to change http://localhost:11434)
 *   LLM responses are cached in eval/llm_cache.json, so re-runs and threshold sweeps are free.
 */
const fs = require('fs');
const path = require('path');
const A = require('../agents');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(name);

// ------------------------------------------------------------------ data
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(c => c.trim() !== ''));
  const numeric = new Set(['Age', 'Stay_Days', 'Claim_Amount', 'Approved_Amount']);
  return body.map(r => Object.fromEntries(head.map((h, i) => {
    const k = h.trim(), v = (r[i] || '').trim();
    return [k, numeric.has(k) ? Number(v) : v];
  })));
}

function loadDataset() {
  const csv = opt('--csv');
  if (csv) return { rows: parseCSV(fs.readFileSync(csv, 'utf8')), source: path.basename(csv) };
  return { rows: require('../data.js'), source: 'data.js (69-record sample: all 51 fraud + 18 clean)' };
}

// ------------------------------------------------------------------ LLM (optional)
function makeLLM({ provider, apiBase, ollamaUrl, ollamaModel }) {
  const cachePath = path.join(__dirname, 'llm_cache.json');
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
  const tag = provider === 'ollama' ? `ollama:${ollamaModel}` : 'gemini';
  const call = async (prompt) => {
    const key = `${tag}\n${prompt}`;
    if (cache[key]) return cache[key];
    let text;
    if (provider === 'ollama') {
      const r = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ollamaModel, stream: false, format: 'json',
          messages: [{ role: 'user', content: prompt }], options: { temperature: 0.2, num_predict: 400 } }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `Ollama HTTP ${r.status}`);
      text = d.message.content;
    } else {
      const r = await fetch(`${apiBase}/api/llm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], json: true, max_tokens: 400 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
      text = d.content.map(c => c.text).join('');
    }
    cache[key] = text;
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 1));
    return text;
  };
  call.tag = tag;
  return call;
}

// ------------------------------------------------------------------ metrics
function score(results) {
  const n = results.length;
  const pos = results.filter(r => r.fraud), neg = results.filter(r => !r.fraud);
  const esc = results.filter(r => r.escalated);
  const tp = esc.filter(r => r.fraud).length, fp = esc.length - tp;
  const fn = pos.length - tp;
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    n, fraud: pos.length, clean: neg.length,
    escalated: esc.length, escalationRatePct: pct(esc.length, n),
    fraudCaught: tp, recallPct: pct(tp, pos.length),
    tooLate_missedFraud: fn, missRatePct: pct(fn, pos.length),
    tooEarly_cleanEscalated: fp, cleanEscalatedPct: pct(fp, neg.length),
    precisionPct: pct(tp, esc.length),
  };
}

async function evaluate(rows, config, callLLM) {
  const out = [];
  for (const claim of rows) {
    const res = await A.runPipeline(claim, { dataset: rows, leaveOneOut: true, config, callLLM });
    out.push({ id: claim.Patient_ID, fraud: claim.Fraud_Flag === 'Yes', escalated: res.escalation.decision === 'HUMAN_REVIEW',
      reasons: res.escalation.reasons.map(x => x.code), risk: res.rule.risk });
  }
  return out;
}

(async () => {
  const { rows, source } = loadDataset();
  const callLLM = flag('--ollama')
    ? makeLLM({ provider: 'ollama', ollamaUrl: opt('--ollama-url', 'http://localhost:11434'), ollamaModel: opt('--ollama', 'qwen2.5:3b') })
    : flag('--llm') ? makeLLM({ provider: 'gemini', apiBase: opt('--api', 'http://localhost:3000') }) : null;
  const mode = callLLM ? `agents + rules (${callLLM.tag})` : 'rules only';
  if (callLLM) console.error(`Running ${rows.length} claims x 4 agents with ${callLLM.tag}; first run may take a while…`);

  const base = await evaluate(rows, A.DEFAULT_CONFIG, callLLM);
  const main = score(base);

  // Sweep the rule-risk threshold to show the too-early / too-late trade-off.
  const sweep = [];
  for (const t of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const r = score(await evaluate(rows, { ...A.DEFAULT_CONFIG, riskThreshold: t }, callLLM));
    sweep.push({ riskThreshold: t, ...r });
  }
  const reasonCounts = {};
  base.forEach(r => r.reasons.forEach(c => { reasonCounts[c] = (reasonCounts[c] || 0) + 1; }));
  const missed = base.filter(r => r.fraud && !r.escalated).map(r => r.id);
  const early = base.filter(r => !r.fraud && r.escalated).map(r => r.id);

  const report = { generatedAt: new Date().toISOString(), source, mode, config: A.DEFAULT_CONFIG, main, sweep, reasonCounts, missed, early };
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(report, null, 2));

  const md = [
    `# MediCore escalation evaluation`, ``,
    `- Data: ${source} (${main.n} claims, ${main.fraud} fraud-flagged)`,
    `- Mode: ${mode}; leave-one-out reference statistics`,
    `- Config: ${JSON.stringify(A.DEFAULT_CONFIG)}`, ``,
    `## Result at the default configuration`, ``,
    `| Metric | Value |`, `|---|---|`,
    `| Claims escalated to a human | ${main.escalated} / ${main.n} (${main.escalationRatePct}%) |`,
    `| Fraud caught (recall) | ${main.fraudCaught} / ${main.fraud} (${main.recallPct}%) |`,
    `| **Too late**: fraud auto-approved | ${main.tooLate_missedFraud} (${main.missRatePct}% of fraud) |`,
    `| **Too early**: clean claims escalated | ${main.tooEarly_cleanEscalated} (${main.cleanEscalatedPct}% of clean) |`,
    `| Precision of escalations | ${main.precisionPct}% |`, ``,
    `Escalation reasons: ${Object.entries(reasonCounts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`, ``,
    `Missed fraud IDs: ${missed.join(', ') || 'none'}  `, `Clean-but-escalated IDs: ${early.join(', ') || 'none'}`, ``,
    `## Threshold sweep (rule-risk threshold)`, ``,
    `| Threshold | Escalated % | Recall % | Too late (missed) | Too early (clean escalated) | Precision % |`,
    `|---|---|---|---|---|---|`,
    ...sweep.map(s => `| ${s.riskThreshold} | ${s.escalationRatePct} | ${s.recallPct} | ${s.tooLate_missedFraud} | ${s.tooEarly_cleanEscalated} | ${s.precisionPct} |`), ``,
    `## Caveats`, ``,
    `- Fraud_Flag is a proxy label, not an adjudicated outcome.`,
    `- The bundled sample over-represents fraud (74% vs roughly 4% in the full dataset), so precision here is inflated. Re-run with --csv on the full file.`,
    `- In this dataset, nearly every fraud-flagged claim is surgery billed for a non-surgical diagnosis, so the procedure-mismatch rule alone separates most cases. Real claims will be harder; the value of this harness is measuring that.`,
  ].join('\n');
  fs.writeFileSync(path.join(__dirname, 'results.md'), md + '\n');
  console.log(md);
})().catch(e => { console.error(e); process.exit(1); });
