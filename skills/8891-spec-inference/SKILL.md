---
name: 8891-spec-inference
description: Use when generating or reviewing 8891 JSON / post-helper content with inferred vehicle specification fields. Constrains which fields may be inferred, which sources are authoritative, and when user confirmation is required.
triggers: 8891, post-helper, json, 規格, 欄位
---

# 8891 Spec Inference

## Goal

Generate 8891 import JSON with the lowest possible hallucination rate.

## Source Priority

1. Google Sheets vehicle fields are authoritative.
2. Team member contact lookup is authoritative for salesperson contact details.
3. Known brand or model mapping tables may be used only when the match is explicit.
4. If evidence is incomplete, do not invent. Leave the field null or conservative.

## Direct Sheet Fields

- `brand`
- `model`
- `year`
- `mileage`
- `price`
- `color`
- `interiorColor`
- `vin`
- `condition`
- `modification`
- `note`

These should be preserved from the sheet data, not rewritten into a different fact.

## Inference Guardrails

- `engineDisplacement`, `transmission`, `fuelType`, `bodyType`, `doors`, `seats`, `drivetrain`, `horsepower`, and `torque` may only be inferred when the car model clearly matches a known mapping.
- If the model name is ambiguous, output `null` instead of guessing.
- Do not infer exact horsepower, torque, or engine displacement from brand alone.
- Do not turn a likely value into a certain value when the prompt only gives a partial match.
- Prefer consistency over completeness for machine-import JSON.

## Contact Rules

- Use the resolved team member for `contact.name`, `contact.mobile`, and `contact.lineId`.
- Keep the dealership phone and address constant unless the source explicitly says otherwise.

## Output Discipline

- Output valid JSON only.
- Keep fields that need user review conservative rather than fabricated.
- If a spec field cannot be supported by the provided data or explicit mapping rules, use `null`.
