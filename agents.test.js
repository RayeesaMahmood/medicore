const test = require('node:test');
const assert = require('node:assert');
const A = require('../agents');
const DATASET = require('../data.js');

const clean = { Patient_ID: 'T1', Age: 40, Diagnosis: 'Asthma', Procedure: 'Consultation', Stay_Days: 2,
  Claim_Amount: 3000, Approved_Amount: 2500, Admission_Date: '2025-01-01', Discharge_Date: '2025-01-03' };
const mismatch = { ...clean, Patient_ID: 'T2', Procedure: 'Surgery', Claim_Amount: 28000, Approved_Amount: 20000 };

// A fake LLM that returns a fixed JSON answer per agent, keyed on the prompt's first line.
const fakeLLM = (answers) => async (prompt) => {
  const key = Object.keys(answers).find(k => prompt.includes(`the ${k} Agent`));
  if (!key) throw new Error('unexpected prompt');
  const a = answers[key];
  if (a instanceof Error) throw a;
  return typeof a === 'string' ? a : JSON.stringify(a);
};
const confident = {
  Clinical: { severity: 'Low', condition: 'asthma', assessment: 'stable', confidence: 0.9 },
  Treatment: { status: 'Appropriate', reason: 'standard', confidence: 0.9 },
  Claim: { status: 'Approved', approved_amount: 2500, reason: 'covered', confidence: 0.9 },
  Fraud: { risk: 'Low', flags: [], reason: 'none', confidence: 0.9 },
};

test('rule agent flags a procedure that does not fit the diagnosis', () => {
  const r = A.ruleAgent(mismatch, A.buildStats(DATASET));
  assert.ok(r.signals.some(s => s.id === 'procedure_mismatch'));
  assert.ok(r.risk >= A.DEFAULT_CONFIG.riskThreshold);
});

test('rule agent flags approved > claimed and inconsistent dates', () => {
  const r = A.ruleAgent({ ...clean, Approved_Amount: 9999, Discharge_Date: '2024-12-30' }, A.buildStats(DATASET));
  const ids = r.signals.map(s => s.id);
  assert.ok(ids.includes('approved_exceeds_claim'));
  assert.ok(ids.includes('date_inconsistency'));
});

test('routine claim with confident, agreeing agents is auto-approved', async () => {
  const res = await A.runPipeline(clean, { dataset: DATASET, callLLM: fakeLLM(confident) });
  assert.strictEqual(res.escalation.decision, 'AUTO_APPROVE', JSON.stringify(res.escalation.reasons));
  assert.strictEqual(res.escalation.mode, 'agents+rules');
});

test('each LLM agent is a separate call and sees earlier agents', async () => {
  const prompts = [];
  const spy = async (p) => { prompts.push(p); return fakeLLM(confident)(p); };
  await A.runPipeline(clean, { dataset: DATASET, callLLM: spy });
  assert.strictEqual(prompts.length, 4);
  assert.ok(prompts[1].includes('"condition":"asthma"'), 'treatment agent sees clinical output');
  assert.ok(prompts[3].includes('rule risk'), 'fraud agent sees rule signals');
});

test('low confidence escalates', async () => {
  const res = await A.runPipeline(clean, { dataset: DATASET, callLLM: fakeLLM({ ...confident,
    Clinical: { ...confident.Clinical, confidence: 0.4 } }) });
  assert.strictEqual(res.escalation.decision, 'HUMAN_REVIEW');
  assert.ok(res.escalation.reasons.some(r => r.code === 'low_confidence'));
});

test('agent failure or malformed output escalates (fail-safe)', async () => {
  for (const bad of [new Error('timeout'), 'not json', JSON.stringify({ status: 'Maybe', confidence: 0.99 })]) {
    const res = await A.runPipeline(clean, { dataset: DATASET, callLLM: fakeLLM({ ...confident, Treatment: bad }) });
    assert.strictEqual(res.escalation.decision, 'HUMAN_REVIEW');
    assert.ok(res.escalation.reasons.some(r => r.code === 'agent_failed'));
  }
});

test('disagreement between agents escalates', async () => {
  const res = await A.runPipeline(clean, { dataset: DATASET, callLLM: fakeLLM({ ...confident,
    Treatment: { status: 'Over-treatment', reason: 'x', confidence: 0.95 } }) });
  assert.ok(res.escalation.reasons.some(r => r.code === 'disagreement'));
});

test('the system never denies on its own', async () => {
  const res = await A.runPipeline(clean, { dataset: DATASET, callLLM: fakeLLM({ ...confident,
    Claim: { status: 'Denied', approved_amount: 0, reason: 'x', confidence: 0.99 } }) });
  assert.strictEqual(res.escalation.decision, 'HUMAN_REVIEW');
  assert.ok(res.escalation.reasons.some(r => r.code === 'denial_needs_human'));
});

test('rules-only mode works without an LLM and still escalates mismatches', async () => {
  const res = await A.runPipeline(mismatch, { dataset: DATASET });
  assert.strictEqual(res.escalation.mode, 'rules-only');
  assert.strictEqual(res.escalation.decision, 'HUMAN_REVIEW');
  assert.strictEqual(res.agents, null);
});

test('extractJSON handles fenced and surrounded JSON', () => {
  assert.deepStrictEqual(A.extractJSON('Sure:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => A.extractJSON('no json here'));
});

test('backend has no hard-coded API key', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'api.js'), 'utf8');
  assert.ok(!/AIza[0-9A-Za-z_-]{20,}/.test(src));
});
