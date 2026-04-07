# Hybrid Build and Deployment Standards for sheet-to-car

## Problem Statement
The current Dockerfile uses Alpine which can lead to `musl` vs `glibc` mismatch issues. It also lacks support for internal network redirection for dependencies in Gitea CI environments.

## Proposed Solution
Align `sheet-to-car` with global workspace standards:
1. **Dependency Management**: Support `INTERNAL_GIT_MIRROR` (Git insteadOf) for internal network redirection.
2. **Environment Consistency**: Switch to Debian-based Docker images (`node:22-bookworm`) to ensure compatibility with production glibc environments.
3. **Deployment**: Keep existing secret-based deployment and container cleanup.

## Success Criteria
- [x] Dockerfile updated to use Bookworm and support `INTERNAL_GIT_MIRROR`.
- [x] `CLAUDE.md` updated with new deployment standards.
