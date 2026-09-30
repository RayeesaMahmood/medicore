/* MediCore LLM providers (browser).
 *
 *   gemini : the api.js backend, which calls Gemini with a server-side key
 *   ollama : a local Ollama server (free, runs on your own machine) - default http://localhost:11434
 *   webllm : a small open model running inside the visitor's browser via WebGPU (free, no server, no key)
 *   rules  : no LLM; the pipeline runs rule checks only
 *   auto   : first available of gemini -> ollama -> webllm (if already loaded) -> rules
 */
(function (root) {
  'use strict';
  const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';
  const WEBLLM_MODELS = {
    'Qwen2.5-0.5B-Instruct-q4f16_1-MLC': 'Qwen2.5 0.5B · fastest · ~1 GB GPU memory',
    'Qwen2.5-1.5B-Instruct-q4f16_1-MLC': 'Qwen2.5 1.5B · balanced · ~1.6 GB (recommended)',
    'Qwen2.5-3B-Instruct-q4f16_1-MLC': 'Qwen2.5 3B · best quality · ~2.5 GB',
  };
  const DEFAULTS = {
    provider: 'auto',
    backendUrl: 'http://localhost:3000',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'qwen2.5:3b',
    webllmModel: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  };
  const LABELS = { gemini: 'Gemini (backend)', ollama: 'Ollama (local)', webllm: 'In-browser model (WebLLM)', rules: 'Rules only' };

  let webllm = { engine: null, model: null, loading: null };

  function getSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('medicore_llm') || '{}'); } catch (e) { /* storage blocked */ }
    try { const legacy = localStorage.getItem('medicore_proxy'); if (legacy && !saved.backendUrl) saved.backendUrl = legacy; } catch (e) {}
    return { ...DEFAULTS, ...saved };
  }
  function saveSettings(patch) {
    const next = { ...getSettings(), ...patch };
    try { localStorage.setItem('medicore_llm', JSON.stringify(next)); } catch (e) { /* storage blocked */ }
    return next;
  }
  const timeout = (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

  // ---------------------------------------------------------------- status checks
  async function geminiStatus(s = getSettings()) {
    try {
      const r = await fetch(`${s.backendUrl}/api/health`, { signal: timeout(2500) });
      const d = await r.json();
      return { ok: !!(r.ok && d.keyConfigured), detail: d.keyConfigured ? `model ${d.model}` : 'backend running but GEMINI_API_KEY not set' };
    } catch (e) { return { ok: false, detail: 'backend not reachable' }; }
  }
  async function ollamaStatus(s = getSettings()) {
    try {
      const r = await fetch(`${s.ollamaUrl}/api/tags`, { signal: timeout(2500) });
      const d = await r.json();
      const models = (d.models || []).map(m => m.name);
      const has = models.includes(s.ollamaModel) || models.includes(s.ollamaModel + ':latest');
      return { ok: r.ok && has, models, detail: !r.ok ? `HTTP ${r.status}` : has ? `model ${s.ollamaModel}` : `running, but model "${s.ollamaModel}" is not pulled (run: ollama pull ${s.ollamaModel})` };
    } catch (e) { return { ok: false, models: [], detail: 'Ollama not reachable (is it running, and is OLLAMA_ORIGINS set?)' }; }
  }
  const webgpuSupported = () => typeof navigator !== 'undefined' && !!navigator.gpu;

  // ---------------------------------------------------------------- WebLLM
  async function loadWebLLM(model, onProgress) {
    if (!webgpuSupported()) throw new Error('This browser has no WebGPU. Use desktop Chrome or Edge.');
    if (webllm.engine && webllm.model === model) return webllm.engine;
    if (webllm.loading) return webllm.loading;
    webllm.loading = (async () => {
      const lib = await import(WEBLLM_URL);
      const engine = await lib.CreateMLCEngine(model, {
        initProgressCallback: (p) => onProgress && onProgress(p.progress || 0, p.text || ''),
      });
      webllm = { engine, model, loading: null };
      return engine;
    })();
    try { return await webllm.loading; } catch (e) { webllm.loading = null; throw e; }
  }

  // ---------------------------------------------------------------- calls
  async function callGemini(s, messages, o) {
    const r = await fetch(`${s.backendUrl}/api/llm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, system: o.system || undefined, json: !!o.json, max_tokens: o.maxTokens }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error((d.error && d.error.message) || `backend HTTP ${r.status}`);
    return d.content.map(c => c.text || '').join('');
  }
  async function callOllama(s, messages, o) {
    const r = await fetch(`${s.ollamaUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: s.ollamaModel, stream: false,
        messages: (o.system ? [{ role: 'system', content: o.system }] : []).concat(messages),
        ...(o.json ? { format: 'json' } : {}),
        options: { temperature: 0.2, num_predict: o.maxTokens || 800 },
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(d.error || `Ollama HTTP ${r.status}`);
    return (d.message && d.message.content) || '';
  }
  async function callWebLLM(s, messages, o) {
    const engine = await loadWebLLM(s.webllmModel, o.onProgress);
    const reply = await engine.chat.completions.create({
      messages: (o.system ? [{ role: 'system', content: o.system }] : []).concat(messages),
      temperature: 0.2, max_tokens: o.maxTokens || 800,
      ...(o.json ? { response_format: { type: 'json_object' } } : {}),
    });
    return reply.choices[0].message.content || '';
  }
  const CALLERS = { gemini: callGemini, ollama: callOllama, webllm: callWebLLM };

  /** Decide which provider to use now. Returns { id, label, detail }. */
  async function resolve(s = getSettings()) {
    if (s.provider === 'rules') return { id: 'rules', label: LABELS.rules, detail: 'selected in settings' };
    if (s.provider === 'gemini' || s.provider === 'ollama') {
      const st = s.provider === 'gemini' ? await geminiStatus(s) : await ollamaStatus(s);
      return st.ok ? { id: s.provider, label: LABELS[s.provider], detail: st.detail }
                   : { id: 'rules', label: LABELS.rules, detail: `${LABELS[s.provider]} unavailable: ${st.detail}` };
    }
    if (s.provider === 'webllm') {
      return webgpuSupported() ? { id: 'webllm', label: LABELS.webllm, detail: s.webllmModel }
                               : { id: 'rules', label: LABELS.rules, detail: 'WebGPU not available in this browser' };
    }
    // auto
    const g = await geminiStatus(s); if (g.ok) return { id: 'gemini', label: LABELS.gemini, detail: g.detail };
    const ol = await ollamaStatus(s); if (ol.ok) return { id: 'ollama', label: LABELS.ollama, detail: ol.detail };
    if (webllm.engine) return { id: 'webllm', label: LABELS.webllm, detail: webllm.model };
    return { id: 'rules', label: LABELS.rules, detail: 'no AI provider found (start Ollama, run the backend, or load the in-browser model in API Configuration)' };
  }

  /** Chat with a specific provider (or the resolved one). */
  async function chat(messages, o = {}) {
    const s = getSettings();
    const id = o.provider || (await resolve(s)).id;
    if (!CALLERS[id]) throw new Error('No AI provider available. Open API Configuration.');
    return CALLERS[id](s, messages, o);
  }

  root.MediCoreLLM = { DEFAULTS, LABELS, WEBLLM_MODELS, getSettings, saveSettings, resolve, chat,
    geminiStatus, ollamaStatus, webgpuSupported, loadWebLLM, isWebLLMLoaded: () => !!webllm.engine };
})(window);
