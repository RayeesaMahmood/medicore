// Vercel serverless function: GET /api/health
const { health } = require('../lib/llm');
module.exports = (req, res) => res.status(200).json(health());
