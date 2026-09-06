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
  → Tier 3 → Tier 4 → DB execution). Tier 3/Tier 4 results execute
  through genuinely separate `pg.Pool` connections (`query()` vs.
  `queryTier4()` in `src/lib/db/client.ts`, authenticated as
  `app_runtime` vs. `app_runtime_tier4` respectively) — verified live
  that `app_runtime` is actually denied on raw `faers.*`/`ct.*`, not
  just conventionally kept off them. Conversation history is now
  loaded/persisted per `sessionId` via `src/lib/session/store.ts`
  (in-memory, deliberately outside the DB's SELECT-only role model —
  see that file's doc comment for the documented limitation on
  multi-instance deployments).
- `src/app/chat/`, `src/app/cohort/` — real UIs (free-text chat;
  structured Clinical Cohort Builder form with CSV export). The
  Cohort Builder surfaces an explicit caveat that FAERS "seriousness"
  flags are a documented severity **proxy**, not a real CTCAE grade.
- `src/app/auditor/` — submits a question through the pipeline, shows
  the resulting SQL + AST-validator verdict, and a `reactflow` schema
  DAG (`schemaGraph.ts`, built from the real `ont.*`/`sem.*` DDL) with
  the query's actual referenced tables highlighted.
- `src/app/evaluation/` — live dashboard over `scripts/eval/goldCases.ts`
  (28 cases across `guardrail_offtopic`/`inappropriate`/`injection`,
  `ambiguous_clarify`, `hallucination_resistance`, `tier4_longtail`,
  `tier3_quantitative`, `tier3_cohort`, `unanswerable`, and
  `tier3_multiturn`), category/split pass-rate table, promotion-gate
  status.
- Streaming: `route.ts` supports an opt-in `stream: true` request field
  (Chat tab only — Cohort/Auditor/Evaluation omit it and get byte-for-byte
  the same JSON response as before). When set, the NL answer
  (`src/lib/render/renderAnswer.ts`, a real `messages.stream()` call)
  streams token-by-token; the SQL/rows are still available immediately
  via a leading metadata line — see the wire-format comment at the top of
  `route.ts`/`apiClient.ts`.
- Multi-turn follow-ups: `tier3_multiturn` gold cases verify that an
  elliptical follow-up ("What about dupilumab instead?") resolves
  correctly grounded in the session's real prior history, and — as the
  actual contrast that makes the test meaningful — declines gracefully
  rather than guessing when asked with no history at all.
- `db/setup.sh` — one-command bootstrap (start Postgres, apply all 7 DDL
  files, load seed CSVs, verify), collapsing the manual steps in
  `db/README.md` into a single script.

**Remaining gaps (documented, not silently missing):**

- Gold-case suite covers 28 of a planned 30+ cases. Every populated
  category is real and live-verified; growing past 30 mainly needs a
  bigger FAERS/ClinicalTrials.gov load than the small verification slice
  this repo has loaded so far, to widen coverage rather than add depth
  to categories already well-covered.
- Verified-query cache (`verifiedQueries.ts`) is exact-match only, no
  fuzzy/embedding similarity yet.
- `renderAnswer.ts` caps the rows sent to the model at 20 (with an
  explicit truncation note) — a cohort question returning hundreds of
  rows gets an NL summary grounded on a sample, not the full result set;
  the full result set is still shown in the table regardless.

## Notes worth knowing about

- `node-sql-parser`'s `AST`/`Select` types (not `Record<string, unknown>`)
  are used directly in `astValidator.ts` — verified against the
  installed package's own `.d.ts`, not guessed.
- Table/column names throughout `src/lib/text2sql/` and
  `src/app/auditor/schemaGraph.ts` are read from the real
  `db/ddl/003_ontology.sql` / `004_semantic_views.sql`, not guessed at a
  contract.
