# MediCore escalation evaluation

- Data: data.js (69-record sample: all 51 fraud + 18 clean) (69 claims, 51 fraud-flagged)
- Mode: rules only; leave-one-out reference statistics
- Config: {"confidenceFloor":0.7,"riskThreshold":0.5,"highValueMultiplier":2.5,"neverAutoDeny":true}

## Result at the default configuration

| Metric | Value |
|---|---|
| Claims escalated to a human | 51 / 69 (73.9%) |
| Fraud caught (recall) | 43 / 51 (84.3%) |
| **Too late**: fraud auto-approved | 8 (15.7% of fraud) |
| **Too early**: clean claims escalated | 8 (44.4% of clean) |
| Precision of escalations | 84.3% |

Escalation reasons: rule_risk 51

Missed fraud IDs: P00014, P00068, P00294, P00393, P00637, P00770, P00928, P01067  
Clean-but-escalated IDs: P00004, P00006, P00007, P00010, P00017, P00018, P00019, P00020

## Threshold sweep (rule-risk threshold)

| Threshold | Escalated % | Recall % | Too late (missed) | Too early (clean escalated) | Precision % |
|---|---|---|---|---|---|
| 0.1 | 75.4 | 84.3 | 8 | 9 | 82.7 |
| 0.2 | 75.4 | 84.3 | 8 | 9 | 82.7 |
| 0.3 | 75.4 | 84.3 | 8 | 9 | 82.7 |
| 0.4 | 73.9 | 84.3 | 8 | 8 | 84.3 |
| 0.5 | 73.9 | 84.3 | 8 | 8 | 84.3 |
| 0.6 | 0 | 0 | 51 | 0 | null |
| 0.7 | 0 | 0 | 51 | 0 | null |
| 0.8 | 0 | 0 | 51 | 0 | null |
| 0.9 | 0 | 0 | 51 | 0 | null |

## Caveats

- Fraud_Flag is a proxy label, not an adjudicated outcome.
- The bundled sample over-represents fraud (74% vs roughly 4% in the full dataset), so precision here is inflated. Re-run with --csv on the full file.
- In this dataset, nearly every fraud-flagged claim is surgery billed for a non-surgical diagnosis, so the procedure-mismatch rule alone separates most cases. Real claims will be harder; the value of this harness is measuring that.
