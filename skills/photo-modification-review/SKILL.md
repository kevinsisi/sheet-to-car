---
name: photo-modification-review
description: Use when vehicle photos are available and the agent must identify visible modifications, special-edition cues, interior details, or likely factory-vs-aftermarket differences without overstating certainty.
triggers: photo, image, modification, visual, special-edition
---

# Photo Modification Review

## Goal

Use photos to improve confidence about visible vehicle features while staying conservative about unsupported claims.

## Rules

- Only describe what is actually visible in the uploaded photos.
- Separate likely factory cues from likely aftermarket changes.
- If a feature is visible but its origin is uncertain, mark it as needing review instead of calling it confirmed.
- Prefer observations that can help sales copy, such as wheel style, carbon-fiber trim, stitching, badges, seats, aero parts, or visible custom materials.
- If a photo angle is insufficient, say what is missing instead of guessing.

## Output Shape

- `findings`: higher-confidence visual findings
- `reviewHints`: uncertain or high-risk claims requiring human confirmation
- `suggestedCopyLines`: conservative lines that could be added to later copy after review
