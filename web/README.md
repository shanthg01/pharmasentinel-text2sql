# PharmaSentinel — web

Next.js (App Router) + TypeScript front end and API layer for the
PharmaSentinel governed text-to-SQL platform.

**Status: all 4 tiers real, verified against a live Postgres with real
FAERS/ClinicalTrials.gov data loaded** — not stubs, not mocked-only. See
"What's actually wired vs. remaining gaps" below for the honest,
file-by-file breakdown of what's finished vs. a documented follow-up.

## Running it

```bash
npm install
cp .env.example .env.local   # ANTHROPIC_API_KEY + PG* values (see db/README.md
                              # for the local Postgres this expects)
npm run dev
```

Open http://localhost:3000 (redirects to `/chat`; also see `/cohort`,
`/auditor`, `/evaluation`).

Other scripts:

```bash
npm run test        # vitest run (unit tests)
npm run test:watch  # vitest watch mode
npm run lint        # eslint
npm run build        # next build
npm run eval:gate    # runs scripts/eval-gate.ts -- hard-fails if any
                      # "test"-split gold case fails (18 cases currently)
```

## What's actually wired vs. remaining gaps

**Fully real, with tests, verified live end-to-end (not just unit-tested):**

- `src/lib/sql/astValidator.ts` — the SQL mutation-prevention gate
  (`node-sql-parser`: single-statement / SELECT-only / table-allowlist /
  LIMIT enforcement).
- `src/lib/guardrails/preChecks.ts` (Layer 1, deterministic) +
  `classify.ts` (Layer 2 — a real `@anthropic-ai/sdk` forced tool-use
  call, zod-validated; **not** an OpenAI-style `messages.parse()` /
  `zodOutputFormat` pattern, which doesn't exist in this SDK).
- `src/lib/text2sql/semanticCatalog.ts` — reads the live `sem.*` catalog
  from `information_schema` for the Tier 3 prompt (no more hardcoded
  placeholder schema).
- `src/lib/text2sql/verifiedQueries.ts` + `tier3.ts` — exact-match
  verified-query cache, then a real grounded Claude call, validated
  through `astValidator.ts`, with one repair-retry on rejection.
- `src/lib/sql/fieldSearch.ts` + `src/lib/text2sql/tier4.ts` — real
  `pg_trgm` trigram search over `ont.field_label`, then a real Claude
  call grounded only on the surfaced candidates, same validate/retry
  pattern.
- `src/app/api/chat/route.ts` — the full orchestration seam (guardrails
  → Tier 3 → Tier 4 → DB execution).
- `src/app/chat/`, `src/app/cohort/` — real UIs (free-text chat;
  structured Clinical Cohort Builder form with CSV export). The
  Cohort Builder surfaces an explicit caveat that FAERS "seriousness"
  flags are a documented severity **proxy**, not a real CTCAE grade.
- `src/app/auditor/` — submits a question through the pipeline, shows
  the resulting SQL + AST-validator verdict, and a `reactflow` schema
  DAG (`schemaGraph.ts`, built from the real `ont.*`/`sem.*` DDL) with
  the query's actual referenced tables highlighted.
- `src/app/evaluation/` — live dashboard over `scripts/eval/goldCases.ts`
  (18 cases across `guardrail_offtopic`/`inappropriate`/`injection`,
  `ambiguous_clarify`, `hallucination_resistance`, `tier4_longtail`),
  category/split pass-rate table, promotion-gate status.

**Remaining gaps (documented, not silently missing):**

- `tier4Pool` in `src/lib/db/client.ts` is still an alias to the same
  pool as the `app_runtime` connection — `db/ddl/005_roles.sql` already
  creates the narrower `app_runtime_tier4` role, but the app doesn't yet
  authenticate a second `pg.Pool` against it. See the TODO in that file.
- Gold-case suite covers 18 of a planned 30+ cases. `tier3_quantitative`,
  `tier3_cohort`, `tier3_multiturn`, and `unanswerable` need real
  reference numbers from a larger FAERS/ClinicalTrials.gov load than the
  small verification slice this repo has loaded so far — deliberately
  left as a follow-up rather than fabricated.
- Streaming: `route.ts` returns a single JSON response, not a token
  stream.
- Conversation history: `route.ts` always calls `generateTier3Sql` with
  an empty history array — nothing persists/loads history by
  `sessionId` yet, so multi-turn follow-ups aren't grounded even though
  `tier3.ts`'s signature already accepts history.
- Verified-query cache (`verifiedQueries.ts`) is exact-match only, no
  fuzzy/embedding similarity yet.

## Notes worth knowing about

- `node-sql-parser`'s `AST`/`Select` types (not `Record<string, unknown>`)
  are used directly in `astValidator.ts` — verified against the
  installed package's own `.d.ts`, not guessed.
- Table/column names throughout `src/lib/text2sql/` and
  `src/app/auditor/schemaGraph.ts` are read from the real
  `db/ddl/003_ontology.sql` / `004_semantic_views.sql`, not guessed at a
  contract.
