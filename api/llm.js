// Vercel serverless function: POST /api/llm
const { complete, rateLimited, originAllowed } = require('../lib/llm');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Use POST' } });
  if (!originAllowed(req.headers.origin)) return res.status(403).json({ error: { message: 'Origin not allowed' } });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ error: { message: 'Too many requests, wait a minute' } });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { status, payload } = await complete(body || {});
  res.status(status).json(payload);
};
