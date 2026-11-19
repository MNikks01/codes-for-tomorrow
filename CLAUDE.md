# CLAUDE.md

Chat backend: Express 5 + TypeScript (strict, ESM/NodeNext) + Prisma 7 (PostgreSQL) + firebase-admin (Firestore).

## Commands

- `pnpm infra:up` – PostgreSQL (:5432, dbs `chat` and `chat_test`) + Firestore emulator (:8080) in Docker
- `pnpm dev` – run the API with `.env`
- `pnpm check` – format check, lint, typecheck, unit tests, build (run before every commit)
- `pnpm test:integration` / `pnpm test:e2e` – need `pnpm infra:up`
- `pnpm db:generate` after any `prisma/schema.prisma` change; `pnpm db:migrate --name <x>` to add a migration

## Rules

- Layering: routes → controller (parse with Zod via `parseInput`) → service (business rules) → repository/store interface. Controllers never touch Prisma/Firestore.
- Concrete infrastructure is chosen only in `src/container.ts`.
- Identity comes from `requireAuth(req)`; never trust user ids from body/params for authorisation.
- Every chat-scoped operation calls `ChatService.assertMember` before Firestore.
- Throw `AppError` subclasses for client-visible errors; anything else becomes a generic 500.
- Imports use `.js` extensions. No `any`, no non-null assertions in `src/`.
- Never log secrets; add new sensitive field names to `REDACTED_PATHS` in `src/config/logger.ts`.
- `src/generated/` is generated – do not edit.

## Docs

Trade-offs: `docs/tradeoffs.md`. Keep `src/docs/openapi.ts` in sync with route changes.
