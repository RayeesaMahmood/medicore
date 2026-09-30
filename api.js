// MediCore backend: a thin proxy between the browser and Gemini.
// The API key is read from the environment (or a local .env file) and never sent to the browser.
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");

// Minimal .env loader, so no extra dependency is needed.
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_URL = process.env.GEMINI_URL ||
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.send(`MediCore backend running (model: ${GEMINI_MODEL})`));
app.get("/api/health", (req, res) => res.json({ ok: true, model: GEMINI_MODEL, keyConfigured: Boolean(GEMINI_API_KEY) }));

// Body: { messages: [{role, content}], system?: string, json?: boolean, max_tokens?: number }
// Response keeps the { content: [{ text }] } shape the front end already uses.
async function handleLLM(req, res) {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: { message: "GEMINI_API_KEY is not set. Copy .env.example to .env and add your key." } });
  }
  try {
    const userText = (req.body.messages || []).map(m => m.content).join("\n\n");
    if (!userText) return res.status(400).json({ error: { message: "messages is empty" } });

    const body = {
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        maxOutputTokens: Math.min(Number(req.body.max_tokens) || 1200, 4096),
        temperature: 0.2,
        ...(req.body.json ? { responseMimeType: "application/json" } : {}),
      },
    };
    if (req.body.system) body.systemInstruction = { parts: [{ text: req.body.system }] };

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: { message: data.error?.message || "Gemini error" } });

    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    res.json({ content: [{ text }] });
  } catch (err) {
    res.status(500).json({ error: { message: "Gemini request failed: " + err.message } });
  }
}

app.post("/api/llm", handleLLM);
app.post("/api/claude", handleLLM); // kept for backward compatibility with older front ends

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`MediCore backend running at http://localhost:${PORT}`);
    if (!GEMINI_API_KEY) console.warn("Warning: GEMINI_API_KEY is not set; AI agents will fail and every claim will escalate.");
  });
}
module.exports = app;
