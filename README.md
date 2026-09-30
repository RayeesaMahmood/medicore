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

Without a backend or API key, the app runs **rules only** (steps 1 and 6), so the public demo still works.

## Human review queue

The **Human Review** page lists escalated claims, sorted by priority, with the reasons for each. A reviewer approves or denies with a note, and every decision is logged. **Triage all claims** runs the rules over the whole dataset and reports how many cases were escalated *too late* (fraud-flagged but auto-approved) and *too early* (clean but escalated).

## Evaluation

```bash
npm run eval                                   # rules only, bundled 69-record sample
npm run eval -- --csv path/to/full_dataset.csv # rules only, full dataset
npm run eval -- --llm --api http://localhost:3000  # agents + rules (backend must be running)
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

```bash
npm install
cp .env.example .env        # then put your Gemini key in .env
npm start                   # backend on http://localhost:3000
# open index.html (or serve the folder) and set the backend URL under API Configuration
npm test                    # 11 unit tests: rules, escalation triggers, fail-safe, never-auto-deny
```

The API key is read only by the server (`api.js`) from `.env` and is never sent to the browser.

## Files

- `agents.js`: pipeline, rule agent, LLM agents, escalation control (browser + Node)
- `data.js`: bundled dataset sample
- `api.js`: Express proxy to Gemini (`/api/llm`, `/api/health`)
- `index.html`: dashboard, agent pipeline, human review queue, claims, analytics, assistant
- `eval/evaluate.js`: escalation evaluation and threshold sweep
- `test/agents.test.js`: unit tests

## Author

Rayeesa Mahmood · [LinkedIn](https://www.linkedin.com/in/rayeesa-mahmood/) · [Portfolio](https://rayeesamahmood.github.io/PORTFOLIO/)
Related paper: *AI-Agent–Integrated Framework for Optimizing Administrative Workflows Across Clinical and Health Insurance Systems* (ICSDE 2026, Best Presenter Award), doi:10.6084/m9.figshare.32041392
