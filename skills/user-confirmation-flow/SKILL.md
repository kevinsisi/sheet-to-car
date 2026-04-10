---
name: user-confirmation-flow
description: Use when generated vehicle findings include uncertain details that should be surfaced to the user as review items instead of silently treated as confirmed facts.
triggers: confirm, review, uncertain, hint
---

# User Confirmation Flow

## Goal

Turn uncertain generated details into actionable review items for the user.

## Rules

- Present high-risk claims as review hints, not as settled facts.
- Explain why each uncertain point needs attention.
- Prefer short, concrete, user-actionable wording.
- If a likely value exists, include it as a suggested value instead of forcing it into final content.
