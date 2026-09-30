// MediCore local backend: serves the app and the same /api routes as the Vercel functions.
// Run: npm start  ->  http://localhost:3000
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
const { complete, health } = require("./lib/llm");
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => res.json(health()));
const handle = async (req, res) => { const { status, payload } = await complete(req.body); res.status(status).json(payload); };
app.post("/api/llm", handle);
app.post("/api/claude", handle); // backward compatibility

// Serve the front end too, so http://localhost:3000 opens the app.
app.use(express.static(__dirname, { index: "index.html", dotfiles: "deny" }));

if (require.main === module) {
  app.listen(PORT, () => {
    const h = health();
    console.log(`MediCore running at http://localhost:${PORT}`);
    console.log(h.keyConfigured ? `AI providers: ${h.providers.join(", ")}` : "Warning: no GEMINI_API_KEY or GROQ_API_KEY set; the app will run rules only.");
  });
}
module.exports = app;
