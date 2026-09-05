import { Pool, type QueryResultRow } from "pg";

/**
 * Build a `pg.Pool` from the standard PG* environment variables
 * (PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD).
 */
function createPool(): Pool {
  return new Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 10,
  });
}

// Module-level singleton, stashed on globalThis so Next.js dev-mode hot
// reload (which can re-evaluate this module many times) doesn't leak a new
// pg.Pool — and its underlying TCP connections — on every reload.
const globalForDb = globalThis as unknown as {
  __pharmasentinelPool?: Pool;
  __pharmasentinelTier4Pool?: Pool;
};

/**
 * Primary connection pool.
 *
 * Authenticates as the `app_runtime` Postgres role (see
 * db/ddl/005_roles.sql, owned by the db/ track), which is granted
 * SELECT-only on `sem.*` and `ont.*`. This is the pool Tier 1–3 code
 * (guardrails' ontology lookups, Tier 3 SQL execution) should use.
 *
 * It must never be granted write access, and it must never be pointed at
 * the raw `faers.*` / `ct.*` tables — those are Tier 4-only, via
 * `tier4Pool` below.
 */
export const pool: Pool = globalForDb.__pharmasentinelPool ?? createPool();
if (process.env.NODE_ENV !== "production") {
  globalForDb.__pharmasentinelPool = pool;
}

/**
 * TODO(tier4): this should be a *separate* `pg.Pool` authenticated as a
 * distinct `app_runtime_tier4` role (SELECT-only on raw `faers.*` / `ct.*`),
 * once that role exists in db/ddl. Keeping it a genuinely separate
 * connection/credential from `pool` above matters: it means a bug in Tier 3
 * code can never read raw tables, and a bug in Tier 4 code can never touch
 * `sem.*`/`ont.*` under elevated grants.
 *
 * For now this is just a placeholder alias to `pool` so the seam
 * (`tier4Pool` exists and is importable) compiles and Tier 4 code can be
 * written against it. Replace with a real second `Pool()` — reading e.g.
 * `PGUSER_TIER4` / `PGPASSWORD_TIER4` env vars — once the role lands.
 */
export const tier4Pool: Pool =
  globalForDb.__pharmasentinelTier4Pool ?? pool;
if (process.env.NODE_ENV !== "production") {
  globalForDb.__pharmasentinelTier4Pool = tier4Pool;
}

/**
 * Run a parameterized query against `pool` and return typed rows.
 *
 * This helper does not itself enforce the SELECT-only / table-allowlist /
 * LIMIT invariants — callers are expected to have already run the SQL
 * through `lib/sql/astValidator.ts` before it ever reaches here.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
}
