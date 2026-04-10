---
name: vehicle-feature-baseline
description: Use when a new car enters the system and the agent needs a first-pass baseline analysis of likely highlights, missing detail, and which photos would most improve confidence.
triggers: baseline, new-car, feature, photo, analysis
---

# Vehicle Feature Baseline

## Goal

Produce a useful first-pass analysis for a newly synced car before any photos are uploaded.

## Focus Areas

- Highlight noteworthy visible facts from sheet data.
- Identify likely selling points that can already be described conservatively.
- Identify which details are still uncertain and require user confirmation.
- Recommend the most valuable photo angles to improve confidence.

## Rules

- Use concise findings that sales staff can act on quickly.
- Do not claim aftermarket modification unless the source data explicitly suggests it.
- When modification appears in sheet data, treat it as a lead worth highlighting and confirming.
- Suggest photo requests based on what is missing, such as front fascia, wheel design, interior trim, badge, seat stitching, engine bay, or rear diffuser.
- Suggested intro lines must stay conservative and usable in later copy generation.

## Output Shape

- `baselineFindings`: short bullet-like findings
- `reviewHints`: items needing user attention
- `recommendedPhotos`: concrete photo requests
- `suggestedIntroLines`: conservative copy-ready lines
