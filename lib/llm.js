// Server-side LLM access shared by the local server (server.js) and the Vercel functions (api/*.js).
// Providers are tried in order; if one fails (quota, outage, bad key) the next one answers.
//   GEMINI_API_KEY  -> Google Gemini (default model gemini-2.5-flash)   free tier at aistudio.google.com
//   GROQ_API_KEY    -> Groq (default model llama-3.3-70b-versatile)     free tier at console.groq.com
// Keys are read from the environment only and never sent to the browser.

const MAX_PROMPT_CHARS = 12000;
const MAX_TOKENS = 1500;

function providers() {
  const list = [];
  if (process.env.GEMINI_API_KEY) list.push({
    id: 'gemini', model: process.env.GEMINI_MODEL || 'gemini-2.5-flash', call: callGemini,
  });
  if (process.env.GROQ_API_KEY) list.push({
    id: 'groq', model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', call: callGroq,
  });
  const order = (process.env.LLM_ORDER || '').split(',').map(s => s.trim()).filter(Boolean);
  if (order.length) list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return list;
}

async function callGemini(p, { text, system, json, maxTokens }) {
  const url = process.env.GEMINI_URL || `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      temperature: 0.1, maxOutputTokens: maxTokens,
      ...(json ? { responseMimeType: 'application/json' } : {}),
      // Agents need short structured answers, not long hidden reasoning.
      ...(/2\.5-flash/.test(p.model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${d.error?.message || 'error'}`);
  const out = d.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '';
  if (!out) throw new Error('Gemini returned an empty answer');
  return out;
}

async function callGroq(p, { text, system, json, maxTokens }) {
  const url = process.env.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: p.model, temperature: 0.1, max_tokens: maxTokens,
      messages: (system ? [{ role: 'system', content: system }] : []).concat([{ role: 'user', content: text }]),
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Groq ${r.status}: ${d.error?.message || 'error'}`);
  const out = d.choices?.[0]?.message?.content || '';
  if (!out) throw new Error('Groq returned an empty answer');
  return out;
}

function health() {
  const ps = providers();
  return { ok: true, keyConfigured: ps.length > 0, providers: ps.map(p => `${p.id}:${p.model}`), model: ps.map(p => p.model).join(' → ') || 'none' };
}

/** body: { messages:[{role,content}], system?, json?, max_tokens? }  ->  { status, payload } */
async function complete(body) {
  const ps = providers();
  if (!ps.length) return { status: 500, payload: { error: { message: 'No AI key configured on the server. Set GEMINI_API_KEY and/or GROQ_API_KEY.' } } };
  const text = (body && Array.isArray(body.messages) ? body.messages : []).map(m => String(m.content || '')).join('\n\n');
  if (!text) return { status: 400, payload: { error: { message: 'messages is empty' } } };
  if (text.length > MAX_PROMPT_CHARS) return { status: 413, payload: { error: { message: 'prompt too long' } } };
  const args = {
    text, system: body.system ? String(body.system).slice(0, 4000) : '', json: !!body.json,
    maxTokens: Math.min(Number(body.max_tokens) || 800, MAX_TOKENS),
  };
  const errors = [];
  for (const p of ps) {
    try {
      const out = await p.call(p, args);
      return { status: 200, payload: { content: [{ text: out }], provider: p.id, model: p.model } };
    } catch (e) { errors.push(e.message); }
  }
  return { status: 502, payload: { error: { message: 'All AI providers failed: ' + errors.join(' | ') } } };
}

// Best-effort abuse protection for a public endpoint (per server instance).
const hits = new Map();
function rateLimited(ip, limit = Number(process.env.RATE_LIMIT_PER_MIN) || 40) {
  const now = Date.now(), win = 60000;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > limit;
}
function originAllowed(origin) {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.length || !origin) return true; // same-origin requests carry no Origin on GET; allow when unset
  return allowed.includes(origin);
}

module.exports = { complete, health, providers, rateLimited, originAllowed };
