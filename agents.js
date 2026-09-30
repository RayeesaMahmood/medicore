/* MediCore multi-agent pipeline with a human-escalation layer.
 *
 * Pipeline for one claim:
 *   1. Rule Agent         deterministic checks against reference statistics (no LLM)
 *   2. Clinical Agent     LLM: severity and likely condition from diagnosis + symptoms
 *   3. Treatment Agent    LLM: is the requested procedure appropriate for that condition?
 *   4. Claim Agent        LLM: coverage decision, given the treatment assessment and plan
 *   5. Fraud Agent        LLM: fraud risk, given the claim and the Rule Agent's signals
 *   6. Escalation Control deterministic: auto-approve, or route to a human reviewer, with reasons
 *
 * Each LLM agent is a separate call that sees the previous agents' outputs, and returns
 * a confidence. If an agent fails or returns malformed output, the case escalates
 * (fail-safe). The system never denies a claim on its own: denials and partial approvals
 * always go to a person.
 *
 * Works in the browser (window.MediCoreAgents) and in Node (require('./agents')).
 */
(function (root) {
  'use strict';

  const DEFAULT_CONFIG = {
    confidenceFloor: 0.70,     // any LLM agent below this -> human review
    riskThreshold: 0.50,       // Rule Agent risk at or above this -> human review
    highValueMultiplier: 2.5,  // claim above this x median claim for the diagnosis -> human review
    neverAutoDeny: true,       // denials / partial approvals always need a person
  };

  // Procedures that are clinically expected for each diagnosis. Anything else is flagged.
  const EXPECTED_PROCEDURES = {
    Asthma:    ['Consultation', 'Blood Test', 'X-Ray'],
    Diabetes:  ['Consultation', 'Blood Test'],
    Infection: ['Consultation', 'Blood Test', 'X-Ray'],
    Fever:     ['Consultation', 'Blood Test'],
    Fracture:  ['Consultation', 'X-Ray', 'MRI', 'Surgery'],
  };

  // Weights for the noisy-OR combination of rule signals.
  const SIGNAL_WEIGHTS = {
    procedure_mismatch: 0.55,
    claim_outlier: 0.30,
    stay_outlier: 0.15,
    approved_exceeds_claim: 0.40,
    date_inconsistency: 0.30,
  };

  // ------------------------------------------------------------------ statistics
  function median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /** Reference statistics per diagnosis and per procedure. `excludeId` gives leave-one-out stats. */
  function buildStats(dataset, excludeId) {
    const rows = excludeId ? dataset.filter(r => r.Patient_ID !== excludeId) : dataset;
    const by = (key) => {
      const g = {};
      rows.forEach(r => { (g[r[key]] = g[r[key]] || []).push(r); });
      return Object.fromEntries(Object.entries(g).map(([k, rs]) => [k, {
        n: rs.length,
        medianClaim: median(rs.map(r => r.Claim_Amount)),
        medianStay: median(rs.map(r => r.Stay_Days)),
      }]));
    };
    return { byDiagnosis: by('Diagnosis'), byProcedure: by('Procedure'), n: rows.length };
  }

  // ------------------------------------------------------------------ 1. Rule Agent
  function ruleAgent(claim, stats) {
    const signals = [];
    const diag = stats.byDiagnosis[claim.Diagnosis];
    const proc = stats.byProcedure[claim.Procedure];

    const expected = EXPECTED_PROCEDURES[claim.Diagnosis];
    if (expected && !expected.includes(claim.Procedure)) {
      signals.push({ id: 'procedure_mismatch', detail: `${claim.Procedure} is not an expected procedure for ${claim.Diagnosis}` });
    }
    if (proc && proc.medianClaim && claim.Claim_Amount > 2 * proc.medianClaim) {
      signals.push({ id: 'claim_outlier', detail: `Claim ₹${claim.Claim_Amount} is more than 2x the median for ${claim.Procedure} (₹${Math.round(proc.medianClaim)})` });
    }
    if (diag && diag.medianStay && claim.Stay_Days > 2.5 * diag.medianStay) {
      signals.push({ id: 'stay_outlier', detail: `Stay of ${claim.Stay_Days} days is more than 2.5x the median for ${claim.Diagnosis} (${diag.medianStay} days)` });
    }
    if (claim.Approved_Amount != null && claim.Approved_Amount > claim.Claim_Amount) {
      signals.push({ id: 'approved_exceeds_claim', detail: 'Approved amount is higher than the amount claimed' });
    }
    if (claim.Admission_Date && claim.Discharge_Date) {
      const days = Math.round((new Date(claim.Discharge_Date) - new Date(claim.Admission_Date)) / 86400000);
      if (days < 0 || (claim.Stay_Days != null && Math.abs(days - claim.Stay_Days) > 1)) {
        signals.push({ id: 'date_inconsistency', detail: `Dates give ${days} days but Stay_Days is ${claim.Stay_Days}` });
      }
    }
    // Noisy-OR: risk = 1 - product(1 - w) over fired signals.
    const risk = 1 - signals.reduce((p, s) => p * (1 - SIGNAL_WEIGHTS[s.id]), 1);
    return { agent: 'rule', risk: Math.round(risk * 1000) / 1000, signals };
  }

  // ------------------------------------------------------------------ LLM agents
  function extractJSON(text) {
    if (typeof text !== 'string') throw new Error('empty response');
    const cleaned = text.replace(/```json|```/g, '');
    const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('no JSON object in response');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x)));
  const oneOf = (v, allowed, field) => {
    if (!allowed.includes(v)) throw new Error(`${field} must be one of ${allowed.join('/')}, got "${v}"`);
    return v;
  };

  const AGENTS = {
    clinical: {
      label: 'Clinical Agent',
      prompt: (c) => `You are the Clinical Agent in a hospital claims pipeline.
Patient age ${c.Age}, gender ${c.Gender || 'unknown'}. Diagnosis: ${c.Diagnosis}. Symptoms: ${c.Symptoms || 'not recorded'}.
Assess clinical severity. Return ONLY JSON:
{"severity":"Low|Moderate|High|Critical","condition":"...","assessment":"one sentence","confidence":0.0-1.0}`,
      validate: (o) => ({
        severity: oneOf(o.severity, ['Low', 'Moderate', 'High', 'Critical'], 'severity'),
        condition: String(o.condition || ''),
        assessment: String(o.assessment || ''),
        confidence: clamp01(o.confidence),
      }),
    },
    treatment: {
      label: 'Treatment Agent',
      prompt: (c, prev) => `You are the Treatment Agent in a hospital claims pipeline.
Diagnosis: ${c.Diagnosis}. Clinical Agent found: ${JSON.stringify(prev.clinical)}.
Requested procedure: ${c.Procedure}. Length of stay: ${c.Stay_Days} days.
Is the procedure clinically appropriate? Return ONLY JSON:
{"status":"Appropriate|Over-treatment|Under-treatment","reason":"one sentence","confidence":0.0-1.0}`,
      validate: (o) => ({
        status: oneOf(o.status, ['Appropriate', 'Over-treatment', 'Under-treatment'], 'status'),
        reason: String(o.reason || ''),
        confidence: clamp01(o.confidence),
      }),
    },
    claim: {
      label: 'Claim Agent',
      prompt: (c, prev) => `You are the Claim Agent in a hospital insurance pipeline.
Insurance plan: ${c.Plan || 'Standard'}. Procedure: ${c.Procedure}. Claim amount: ₹${c.Claim_Amount}.
Treatment Agent found: ${JSON.stringify(prev.treatment)}.
Recommend a coverage decision. Return ONLY JSON:
{"status":"Approved|Partial|Denied","approved_amount":0,"reason":"one sentence","confidence":0.0-1.0}`,
      validate: (o) => ({
        status: oneOf(o.status, ['Approved', 'Partial', 'Denied'], 'status'),
        approved_amount: Math.max(0, Math.round(Number(o.approved_amount) || 0)),
        reason: String(o.reason || ''),
        confidence: clamp01(o.confidence),
      }),
    },
    fraud: {
      label: 'Fraud Agent',
      prompt: (c, prev) => `You are the Fraud Agent in a hospital insurance pipeline.
Claim: ${c.Diagnosis}, ${c.Procedure}, ₹${c.Claim_Amount}, ${c.Stay_Days} days.
Claim Agent recommended: ${JSON.stringify(prev.claim)}.
Deterministic rule checks raised: ${JSON.stringify(prev.rule.signals.map(s => s.detail))} (rule risk ${prev.rule.risk}).
Assess fraud risk independently. Return ONLY JSON:
{"risk":"Low|Medium|High","flags":["..."],"reason":"one sentence","confidence":0.0-1.0}`,
      validate: (o) => ({
        risk: oneOf(o.risk, ['Low', 'Medium', 'High'], 'risk'),
        flags: Array.isArray(o.flags) ? o.flags.map(String) : [],
        reason: String(o.reason || ''),
        confidence: clamp01(o.confidence),
      }),
    },
  };
  const LLM_ORDER = ['clinical', 'treatment', 'claim', 'fraud'];

  // Shared instructions so confidence values mean something and can be compared across agents.
  const CALIBRATION = `
Rules for your answer:
- Use only the facts given; do not invent tests, history or prices.
- "confidence" is your probability (0.0-1.0) that your main judgement is correct. Be calibrated:
  use 0.9+ only when the facts clearly support it, 0.5-0.7 when information is missing or ambiguous.
- Keep text fields to one short sentence. Output the JSON object only.`;

  async function runLLMAgent(name, claim, prev, callLLM) {
    const def = AGENTS[name];
    try {
      const text = await callLLM(def.prompt(claim, prev) + CALIBRATION);
      return { agent: name, ok: true, ...def.validate(extractJSON(text)) };
    } catch (e) {
      return { agent: name, ok: false, error: e.message, confidence: 0 };
    }
  }

  // ------------------------------------------------------------------ 6. Escalation Control
  function escalate(claim, rule, llm, stats, config) {
    const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
    const reasons = [];

    if (rule.risk >= cfg.riskThreshold) {
      reasons.push({ code: 'rule_risk', text: `Rule risk ${rule.risk.toFixed(2)} ≥ ${cfg.riskThreshold}: ${rule.signals.map(s => s.detail).join('; ')}` });
    }
    const diag = stats.byDiagnosis[claim.Diagnosis];
    if (diag && diag.medianClaim && claim.Claim_Amount > cfg.highValueMultiplier * diag.medianClaim) {
      reasons.push({ code: 'high_value', text: `High-value claim: more than ${cfg.highValueMultiplier}x the median for ${claim.Diagnosis}` });
    }

    if (llm) {
      LLM_ORDER.forEach(n => {
        const a = llm[n];
        if (!a || !a.ok) reasons.push({ code: 'agent_failed', text: `${AGENTS[n].label} gave no valid answer (${a ? a.error : 'not run'})` });
        else if (a.confidence < cfg.confidenceFloor) reasons.push({ code: 'low_confidence', text: `${AGENTS[n].label} confidence ${a.confidence.toFixed(2)} < ${cfg.confidenceFloor}` });
      });
      const t = llm.treatment, c = llm.claim, f = llm.fraud;
      if (t && t.ok && c && c.ok && t.status !== 'Appropriate' && c.status === 'Approved') {
        reasons.push({ code: 'disagreement', text: `Treatment Agent says "${t.status}" but Claim Agent approved` });
      }
      if (f && f.ok && c && c.ok && f.risk === 'High' && c.status !== 'Denied') {
        reasons.push({ code: 'disagreement', text: 'Fraud Agent rates risk High but Claim Agent did not deny' });
      }
      if (f && f.ok && f.risk === 'Low' && rule.risk >= cfg.riskThreshold) {
        reasons.push({ code: 'disagreement', text: 'Fraud Agent rates risk Low but rule checks disagree' });
      }
      if (cfg.neverAutoDeny && c && c.ok && c.status !== 'Approved') {
        reasons.push({ code: 'denial_needs_human', text: `Claim Agent recommends "${c.status}": only a person can deny or reduce a claim` });
      }
    }

    const high = rule.risk >= 0.8 || (llm && llm.fraud && llm.fraud.ok && llm.fraud.risk === 'High');
    return {
      decision: reasons.length ? 'HUMAN_REVIEW' : 'AUTO_APPROVE',
      priority: reasons.length ? (high ? 'high' : 'normal') : null,
      reasons,
      mode: llm ? 'agents+rules' : 'rules-only',
    };
  }

  // ------------------------------------------------------------------ full pipeline
  /**
   * Run the pipeline on one claim.
   * opts.dataset  reference data for statistics (required)
   * opts.callLLM  async (prompt) => text; omit for rules-only mode
   * opts.onStep   (name, result) => void, for progress UI
   * opts.config   overrides for DEFAULT_CONFIG
   */
  async function runPipeline(claim, opts) {
    const stats = buildStats(opts.dataset, opts.leaveOneOut ? claim.Patient_ID : null);
    const step = opts.onStep || (() => {});
    const rule = ruleAgent(claim, stats);
    step('rule', rule);

    let llm = null;
    if (opts.callLLM) {
      llm = { rule };
      for (const name of LLM_ORDER) {
        step(name, { running: true });
        llm[name] = await runLLMAgent(name, claim, llm, opts.callLLM);
        step(name, llm[name]);
      }
    }
    const escalation = escalate(claim, rule, llm, stats, opts.config);
    step('escalation', escalation);
    return { claim, rule, agents: llm, escalation };
  }

  const api = { DEFAULT_CONFIG, EXPECTED_PROCEDURES, SIGNAL_WEIGHTS, AGENTS, LLM_ORDER,
    buildStats, ruleAgent, escalate, runPipeline, extractJSON, median };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MediCoreAgents = api;
})(typeof window !== 'undefined' ? window : globalThis);
