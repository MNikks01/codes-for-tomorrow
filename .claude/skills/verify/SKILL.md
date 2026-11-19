---
name: verify
description: Run this project's full verification gate (format, lint, types, all test suites with coverage, build, Docker) and report real results. Use before committing or claiming work is done.
---

# Verify the chat backend

Run each step and report its actual output. Stop and fix on the first failure; never weaken a test to pass.

1. `pnpm infra:up` and wait until `docker compose -f infra/docker-compose.yml ps` shows postgres and firestore healthy.
2. `pnpm check` (format check, ESLint, `tsc --noEmit`, unit tests, build).
3. `pnpm test:coverage` (unit + integration + e2e + security; coverage thresholds are enforced in `vitest.config.ts`).
4. `docker compose -f infra/docker-compose.yml up -d --build` then `curl -fsS localhost:3000/health/ready`.
5. `git status --short` must not list `.env`, credentials, or `src/generated/`.

Report: pass/fail per step, test counts, coverage summary, and anything skipped with the reason.
