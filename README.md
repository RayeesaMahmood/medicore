# MediCore: multi-agent claims pipeline with human escalation

MediCore reviews hospital insurance claims with a pipeline of agents, and decides for each claim whether it can be approved automatically or must go to a person. The central design rule: **the system may approve routine claims, but it never denies or reduces a claim on its own.** Uncertain, conflicting or adverse decisions are escalated to a human reviewer, with the reasons.

## Pipeline

| Step | Agent | Type | Output |
|---|---|---|---|
| 1 | Rule Agent | deterministic | risk score (noisy-OR of rule signals) and the signals that fired |
| 2 | Clinical Agent | LLM | severity, likely condition, confidence |
| 3 | Treatment Agent | LLM (sees 2) | is the procedure appropriate? confidence |
| 4 | Claim Agent | LLM (sees 3) | approve / partial / deny, confidence |
| 5 | Fraud Agent | LLM (sees 4 and the rule signals) | fraud risk, flags, confidence |
| 6 | Escalation Control | deterministic | `AUTO_APPROVE` or `HUMAN_REVIEW` + reasons + priority |

Each LLM agent is a separate call with its own prompt and a validated JSON schema. A failed call or malformed answer counts as zero confidence, so the case escalates (fail-safe).

**Escalation triggers** (all configurable in `agents.js` → `DEFAULT_CONFIG`):
- rule risk ≥ `riskThreshold` (0.5)
- claim above `highValueMultiplier` × the median claim for its diagnosis (2.5×)
- any LLM agent below `confidenceFloor` (0.7), or failed
- disagreement: e.g. the Treatment Agent says over-treatment but the Claim Agent approves; the Fraud Agent says high risk but the claim was not denied; the Fraud Agent says low risk while the rules disagree
- the Claim Agent recommends a denial or partial approval (`neverAutoDeny`)

Rule signals: procedure not expected for the diagnosis, claim more than 2× the procedure median, stay more than 2.5× the diagnosis median, approved amount above claimed amount, and admission/discharge dates that do not match the stay length.

The AI agents can run on a free in-browser model, a free local Ollama model, or Gemini (see below). With none available, the app runs **rules only** (steps 1 and 6).

## Free AI providers (no key, no expiry)

Open **API Configuration** and pick where the agents' AI runs. `Auto` uses the first one available.

| Provider | Cost | Where it runs | Best for |
|---|---|---|---|
| **In-browser model** (WebLLM, Qwen2.5 0.5B / 1.5B / 3B) | free forever | the visitor's own GPU, via WebGPU | the public demo: anyone can run the real agents, no server, no key, data never leaves the device |
| **Ollama** (e.g. `qwen2.5:3b`, `llama3.2:3b`) | free forever | your own computer | development and running the evaluation |
| **Cloud AI**: Gemini 2.5 Flash, falls back to Groq Llama 3.3 70B | free tiers | Vercel `/api` functions (or `server.js` locally) | most accurate answers, works for every visitor |
| **Rules only** | free | anywhere | fallback when no AI is available |

**In-browser model.** Needs desktop Chrome or Edge (WebGPU). Click *Load in-browser model*; the first load downloads roughly 1–2.5 GB depending on the model, then the browser caches it.

**Ollama.**
```bash
# install from https://ollama.com, then
ollama pull qwen2.5:3b
# to let the hosted site (e.g. medicore-psi.vercel.app) call your local Ollama, allow its origin:
#   Windows (PowerShell):  $env:OLLAMA_ORIGINS="*"; ollama serve
#   macOS / Linux:         OLLAMA_ORIGINS="*" ollama serve
```
Chrome may ask to allow the site to access devices on your local network; allow it. Opening `index.html` from your own machine works without this step.

**Evaluation with Ollama (free):**
```bash
npm run eval -- --ollama qwen2.5:3b
```
LLM answers are cached in `eval/llm_cache.json`, so re-runs and threshold sweeps cost nothing.

## Human review queue

The **Human Review** page lists escalated claims, sorted by priority, with the reasons for each. A reviewer approves or denies with a note, and every decision is logged. **Triage all claims** runs the rules over the whole dataset and reports how many cases were escalated *too late* (fraud-flagged but auto-approved) and *too early* (clean but escalated).

## Evaluation

```bash
npm run eval                                   # rules only, bundled 69-record sample
npm run eval -- --csv path/to/full_dataset.csv # rules only, full dataset
npm run eval -- --ollama qwen2.5:3b            # agents + rules with a free local model
npm run eval -- --llm --api http://localhost:3000  # agents + rules via the Gemini backend
```

Results are written to `eval/results.md` and `eval/results.json`. Reference statistics are computed leave-one-out, so a claim never influences its own check. Current result on the bundled sample (rules only):

| | |
|---|---|
| Escalated to a human | 51 / 69 (73.9%) |
| Fraud caught | 43 / 51 (84.3%) |
| Too late: fraud auto-approved | 8 (all fracture surgeries: a clinically plausible procedure, so no rule fires) |
| Too early: clean claims escalated | 8 of 18 (all X-ray/MRI for diabetes, fever or infection: the expected-procedure list is too strict) |

**Caveats.** `Fraud_Flag` is a proxy label, not an adjudicated outcome. The bundled sample contains all 51 fraud-flagged records from the 1,200-record Kaggle file plus 18 clean ones, so fraud is heavily over-represented (74% vs about 4%) and precision is inflated; run the evaluation on the full CSV. Both error types come from hand-written rules, which is exactly what the next step (learned, adaptive escalation) is meant to measure and improve.

## Run it

### On Vercel (the live site)
1. Get a free key: Gemini at https://aistudio.google.com/apikey and, as a fallback, Groq at https://console.groq.com/keys.
2. In Vercel: **Project → Settings → Environment Variables**, add `GEMINI_API_KEY` and `GROQ_API_KEY` (and optionally `ALLOWED_ORIGINS=https://medicore-psi.vercel.app`).
3. **Deployments → ⋯ → Redeploy**. The `api/` folder becomes serverless functions, and the top bar shows *AI: Cloud AI (Gemini / Groq)*.

The functions accept only short prompts, cap output length, limit each visitor to 40 requests a minute, and (with `ALLOWED_ORIGINS`) refuse calls from other sites, so your free quota cannot be used elsewhere.

### Locally
```bash
npm install
cp .env.example .env        # add GEMINI_API_KEY and/or GROQ_API_KEY
npm start                   # app + API on http://localhost:3000
npm test                    # unit tests
```

## Files

- `agents.js`: pipeline, rule agent, LLM agents, escalation control (browser + Node)
- `data.js`: bundled dataset sample
- `llm-providers.js`: AI provider switch (in-browser WebLLM, Ollama, Gemini backend, rules only)
- `lib/llm.js`: server-side AI calls (Gemini, Groq fallback), limits and rate limiting
- `api/llm.js`, `api/health.js`: Vercel serverless functions
- `server.js`: local server (`npm start`) with the same `/api` routes, also serves the app
- `index.html`: dashboard, agent pipeline, human review queue, claims, analytics, assistant
- `eval/evaluate.js`: escalation evaluation and threshold sweep
- `test/agents.test.js`: unit tests

## Author

Rayeesa Mahmood · [LinkedIn](https://www.linkedin.com/in/rayeesa-mahmood/) · [Portfolio](https://rayeesamahmood.github.io/PORTFOLIO/)
Related paper: *AI-Agent–Integrated Framework for Optimizing Administrative Workflows Across Clinical and Health Insurance Systems* (ICSDE 2026, Best Presenter Award), doi:10.6084/m9.figshare.32041392
