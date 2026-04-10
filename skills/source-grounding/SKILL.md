---
name: source-grounding
description: Use when generating any structured vehicle data or summary that must stay grounded in sheet fields, VIN, or explicitly identified evidence. Prevents unsupported claims from being presented as facts.
triggers: source, evidence, spec, feature, car, vehicle
---

# Source Grounding

## Goal

Keep vehicle outputs traceable to real inputs instead of unsupported assumptions.

## Rules

- Treat Google Sheets fields as primary truth for visible inventory data.
- Treat VIN as a secondary source only when it is explicitly present.
- Distinguish between observed facts, inferred likelihoods, and unanswered questions.
- If a statement cannot be traced to sheet fields, VIN, or an explicit mapping rule, mark it as needing review instead of writing it as fact.
- Preserve user-provided wording and visible facts from the source data.

## Output Discipline

- Prefer short factual findings over speculative marketing copy.
- Surface uncertainty clearly in review hints.
- If the source is thin, output fewer claims rather than broader claims.
