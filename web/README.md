# PharmaSentinel — web

Next.js (App Router) + TypeScript front end and API layer for the
PharmaSentinel governed text-to-SQL platform.

**Status: skeleton pass.** This scaffolds the architecture — types,
interfaces, module seams, tests for the parts that are genuinely
implemented — so the next passes have a structure to build into. It is
**not** a finished feature. See "What's actually wired vs. stubbed" below
before assuming any given tab or tier does something real.

## Running it

```bash
npm install
cp .env.example .env.local   # then fill in ANTHROPIC_API_KEY and PG* values
npm run dev
```

Open http://localhost:3000.

Other scripts:

```bash
npm run test        # vitest run (unit tests)
npm run test:watch  # vitest watch mode
npm run lint        # eslint
npm run build        # next build
npm run eval:gate    # runs scripts/eval-gate.ts (trivially passes — goldCases.ts is empty)
```

## What's actually wired vs. stubbed

**Genuinely functional (has real logic + tests):**

- `src/lib/sql/astValidator.ts` — the SQL mutation-prevention gate
  (single-statement / SELECT-only / table-allowlist / LIMIT enforcement),
  via `node-sql-parser`. Has `astValidator.test.ts` covering the cases in
  the spec (valid select, DROP/DELETE/UPDATE rejected, multi-statement
  injection rejected, non-allowlisted table rejected, LIMIT injected/capped).
- `src/lib/guardrails/preChecks.ts` — Layer 1 deterministic checks (empty
  input, hardcoded PHI-request patterns, too-short-question clarify). Has
  `preChecks.test.ts`.
- `src/lib/guardrails/classify.ts` — Layer 2 LLM classifier. Makes a real
  `@anthropic-ai/sdk` call with a Zod-validated structured output schema.
  Tested with a mocked Anthropic client (`classify.test.ts`) — never hits
  the real API in tests.
- `src/lib/guardrails/index.ts` — combines the two into `runGuardrails()`.
- `src/app/api/chat/route.ts` — the orchestration seam (guardrails -> Tier
  3 -> Tier 4 -> DB execution), end to end at the *control-flow* level.
  Tested with mocked dependencies (`route.test.ts`) so it never hits a real
  DB or Anthropic.
- `src/lib/db/client.ts` — a real `pg.Pool` + `query<T>()` helper against
  the standard `PG*` env vars.

**Wired end-to-end but with placeholder content (will produce weak or
wrong answers until filled in):**

- `src/lib/text2sql/tier3.ts` — makes a real Claude call and validates its
  SQL output via `astValidator.ts`, but the schema description in the
  prompt is a **hardcoded placeholder**, not the real `sem.*` catalog.
  See the TODOs in that file (`loadSemanticViewCatalog()`, verified-query
  cache, explicit FK/join contract, repair-prompt retry loop) — none of
  those are built yet.
- `tier4Pool` in `src/lib/db/client.ts` is currently an alias to the same
  pool as Tier 1–3's `app_runtime` connection. It is **not** actually a
  separate `app_runtime_tier4` role/connection yet — that role doesn't
  exist in `db/ddl` at time of writing. Treat this as unsafe to point at
  raw tables until it's a real second connection.

**Fully stubbed (always returns a fixed placeholder result):**

- `src/lib/text2sql/tier4.ts` — `tier4Fallback()` always returns
  `{ kind: "no_answer" }`. The real plan (pg_trgm similarity search over
  `ont.field`/`ont.drug_synonym`, LLM SQL-gen grounded on the ranked
  candidates, validation against the raw-table allowlist) is documented in
  a comment block in that file but not implemented.
- The four tabs in `src/app/page.tsx` (Chat, Cohort Builder, SQL + Schema
  Auditor, Evaluation) are placeholder `<div>`s with a heading and one
  descriptive sentence each — no real UI behind any of them yet. There is
  no client-side wiring to `/api/chat` from the Chat tab yet.
- `scripts/eval/goldCases.ts` — an empty, typed array with a large TODO
  comment listing the categories a real gold set needs (30+ cases across
  `tier3_quantitative`, `tier3_cohort`, `tier3_multiturn`, `tier4_longtail`,
  `unanswerable`, `ambiguous_clarify`, the three `guardrail_*` categories,
  and `hallucination_resistance`). `scripts/eval/runner.ts` and
  `scripts/eval-gate.ts` are real drivers, but with zero cases to run they
  trivially pass.
- Streaming: `route.ts` returns a single JSON response, not a stream. Noted
  as a TODO in that file — add streaming once NL-rendering of results is
  built.
- Conversation history: `route.ts` always calls `generateTier3Sql` with an
  empty history array; nothing persists/loads history by `sessionId` yet,
  so `tier3_multiturn`-style follow-ups aren't actually grounded yet even
  though the `tier3.ts` function signature already accepts history.

## Assumptions worth knowing about

- The DB schema (`sem.*`, `ont.*`, raw `faers.*`/`ct.*`) is owned by a
  concurrent track (`db/`) and wasn't available to inspect while writing
  this pass — table/column names used in placeholder prompts and
  allowlists are best-effort guesses at the contract described in the
  project brief, not verified against real DDL.
- Dependency versions in `package.json` are recent-stable `^` ranges
  chosen without running `npm install` (per instructions) — re-check
  `@anthropic-ai/sdk` in particular against its current release once you
  do install, since its structured-output helpers (`messages.parse` +
  `zodOutputFormat`) are a relatively new API surface.
- `node-sql-parser`'s exact AST shape for `LIMIT` (`{ seperator, value }`)
  is written from its documented/known API; if the installed version's
  shape differs, `astValidator.test.ts` will catch it immediately.
