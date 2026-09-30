const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Fake Gemini and Groq servers. `mode.gemini` = 'ok' | 'quota'.
const mode = { gemini: 'ok' };
let seen = [];
function startFake() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        const body = JSON.parse(b);
        seen.push({ url: req.url, headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        if (req.url.startsWith('/gemini')) {
          if (mode.gemini === 'quota') { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: 'quota exceeded' } })); }
          return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"from":"gemini"}' }] } }] }));
        }
        res.end(JSON.stringify({ choices: [{ message: { content: '{"from":"groq"}' } }] }));
      });
    }).listen(0, () => resolve(srv));
  });
}

test('server-side AI: Gemini first, Groq fallback, limits, Vercel handlers', async (t) => {
  const srv = await startFake();
  const base = `http://localhost:${srv.address().port}`;
  Object.assign(process.env, { GEMINI_API_KEY: 'g-test', GROQ_API_KEY: 'q-test',
    GEMINI_URL: `${base}/gemini`, GROQ_URL: `${base}/groq`, ALLOWED_ORIGINS: 'https://medicore-psi.vercel.app', RATE_LIMIT_PER_MIN: '3' });
  delete require.cache[require.resolve('../lib/llm')];
  const llm = require('../lib/llm');
  const msg = { messages: [{ role: 'user', content: 'hi' }], json: true, max_tokens: 99999 };

  await t.test('uses Gemini when it works, with JSON mode and capped tokens', async () => {
    seen = []; mode.gemini = 'ok';
    const r = await llm.complete(msg);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.payload.provider, 'gemini');
    assert.strictEqual(seen[0].headers['x-goog-api-key'], 'g-test');
    assert.strictEqual(seen[0].body.generationConfig.responseMimeType, 'application/json');
    assert.ok(seen[0].body.generationConfig.maxOutputTokens <= 1500);
  });

  await t.test('falls back to Groq when Gemini is out of quota', async () => {
    seen = []; mode.gemini = 'quota';
    const r = await llm.complete(msg);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.payload.provider, 'groq');
    assert.strictEqual(r.payload.content[0].text, '{"from":"groq"}');
    assert.strictEqual(seen[1].headers.authorization, 'Bearer q-test');
    assert.deepStrictEqual(seen[1].body.response_format, { type: 'json_object' });
  });

  await t.test('rejects empty and oversized prompts', async () => {
    assert.strictEqual((await llm.complete({ messages: [] })).status, 400);
    assert.strictEqual((await llm.complete({ messages: [{ content: 'x'.repeat(20000) }] })).status, 413);
  });

  await t.test('health never exposes keys', () => {
    const h = llm.health();
    assert.strictEqual(h.keyConfigured, true);
    assert.ok(!JSON.stringify(h).includes('g-test') && !JSON.stringify(h).includes('q-test'));
  });

  await t.test('Vercel /api/llm handler: origin lock, method check, rate limit', async () => {
    mode.gemini = 'ok';
    delete require.cache[require.resolve('../api/llm')];
    const handler = require('../api/llm');
    const call = (req) => new Promise(resolve => {
      const res = { code: 0, status(c) { this.code = c; return this; }, json(p) { resolve({ code: this.code, p }); } };
      handler({ method: 'POST', headers: {}, body: msg, ...req }, res);
    });
    assert.strictEqual((await call({ method: 'GET' })).code, 405);
    assert.strictEqual((await call({ headers: { origin: 'https://evil.example' } })).code, 403);
    const ok = await call({ headers: { origin: 'https://medicore-psi.vercel.app', 'x-forwarded-for': '9.9.9.9' } });
    assert.strictEqual(ok.code, 200); assert.strictEqual(ok.p.provider, 'gemini');
    await call({ headers: { 'x-forwarded-for': '9.9.9.9' } });
    await call({ headers: { 'x-forwarded-for': '9.9.9.9' } });
    assert.strictEqual((await call({ headers: { 'x-forwarded-for': '9.9.9.9' } })).code, 429);
  });

  srv.close();
});
