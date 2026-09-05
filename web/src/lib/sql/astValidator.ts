import { Parser } from "node-sql-parser";
import type { AST, Select } from "node-sql-parser";

export interface ValidateSqlOptions {
  /**
   * Fully-qualified table names this query is allowed to reference, e.g.
   * `["sem.faers_case_summary", "sem.faers_drug_reaction"]` for Tier 3
   * callers, or the raw `faers.*`/`ct.*` allowlist for Tier 4 callers.
   * A bare (unqualified) allowlist entry matches an unqualified table
   * reference in the query.
   */
  allowedTables: string[];
  /**
   * Hard ceiling enforced on LIMIT: injected if missing, and used to cap
   * an existing LIMIT that exceeds it. Defaults to 1000.
   */
  maxLimit?: number;
}

export type ValidateSqlResult =
  | { ok: true; sql: string }
  | { ok: false; reason: string };

const DEFAULT_MAX_LIMIT = 1000;

// A single shared parser instance — node-sql-parser's Parser is stateless
// per-call, so this is safe to reuse across requests.
const parser = new Parser();

/**
 * The SQL mutation-prevention gate shared by Tier 3 and Tier 4.
 *
 * Validates that a candidate SQL string is:
 *   (a) exactly one statement,
 *   (b) a `SELECT` (never DDL/DML/COPY/GRANT/etc.),
 *   (c) only touching tables in the caller-supplied allowlist, and
 *   (d) bounded by a LIMIT — injecting one if absent, capping it if it
 *       exceeds `maxLimit`.
 *
 * Contract:
 *   - For any SQL that `node-sql-parser` CAN parse, this function returns a
 *     `ValidateSqlResult` — it never throws for a bad-but-parseable query
 *     (e.g. `DROP TABLE ...`, a disallowed table, a multi-statement
 *     injection attempt all come back as `{ ok: false, reason }`).
 *   - It throws only when the input is not parseable SQL at all. Callers
 *     that cannot guarantee well-formed input up front (e.g. raw LLM
 *     output) should wrap the call in try/catch and treat a throw the same
 *     as a validation failure.
 */
export function validateSql(
  sql: string,
  options: ValidateSqlOptions,
): ValidateSqlResult {
  const maxLimit = options.maxLimit ?? DEFAULT_MAX_LIMIT;

  // Let a genuine parse failure (malformed SQL) throw — see contract above.
  const rawAst = parser.astify(sql, { database: "postgresql" });

  const statements = (Array.isArray(rawAst) ? rawAst : [rawAst]).filter(
    (stmt): stmt is AST => stmt !== null && stmt !== undefined,
  );

  if (statements.length !== 1) {
    return {
      ok: false,
      reason: `Expected exactly one SQL statement, found ${statements.length}.`,
    };
  }

  const statement = statements[0];

  if (statement === undefined || statement.type !== "select") {
    return {
      ok: false,
      reason: `Only SELECT statements are allowed (got "${String(
        statement?.type,
      )}").`,
    };
  }

  // Table allowlist check. We rely on the parser's own table extraction
  // (rather than re-walking the AST ourselves) so joins, subqueries, and
  // CTEs are all covered.
  let tableListEntries: string[];
  try {
    tableListEntries = parser.tableList(sql, { database: "postgresql" });
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to extract referenced tables: ${(err as Error).message}`,
    };
  }

  const allowedSet = new Set(options.allowedTables.map((t) => t.toLowerCase()));
  const referencedTables = tableListEntries.map(normalizeTableListEntry);

  for (const table of referencedTables) {
    if (!allowedSet.has(table.toLowerCase())) {
      return {
        ok: false,
        reason: `Table "${table}" is not in the allowlist for this tier.`,
      };
    }
  }

  applyLimit(statement, maxLimit);

  const finalSql = parser.sqlify(statement, { database: "postgresql" });
  return { ok: true, sql: finalSql };
}

/**
 * `node-sql-parser`'s `tableList()` entries look like
 * `"select::<schema>::<table>"`, where `<schema>` is the literal string
 * `"null"` when the query didn't schema-qualify the table. Normalize to
 * `"schema.table"` (or bare `"table"`) so entries can be compared directly
 * against allowlist strings like `"sem.faers_case_summary"`.
 */
function normalizeTableListEntry(entry: string): string {
  const parts = entry.split("::");
  const schema = parts[1];
  const table = parts[2] ?? parts[parts.length - 1] ?? entry;
  if (!schema || schema === "null") {
    return table;
  }
  return `${schema}.${table}`;
}

interface LimitClauseValue {
  type: string;
  value: number;
}

interface LimitClause {
  seperator: string;
  value: LimitClauseValue[];
}

interface SelectAstWithLimit {
  limit?: LimitClause | null;
}

/**
 * Mutates `statement.limit` in place: injects a `LIMIT maxLimit` if the
 * query has none, or caps an existing LIMIT's value down to `maxLimit`.
 * Note node-sql-parser's `LIMIT a, b` / `LIMIT b OFFSET a` form encodes
 * both numbers in `value` — we only ever cap the last entry (the row
 * count), leaving an offset untouched.
 *
 * `Select`'s own `.limit` typing is looser than what node-sql-parser
 * actually produces at runtime, so this narrows through the
 * runtime-accurate `SelectAstWithLimit` shape rather than fighting the
 * library's published type.
 */
function applyLimit(statement: Select, maxLimit: number): void {
  const stmt = statement as unknown as SelectAstWithLimit;

  if (!stmt.limit || !stmt.limit.value || stmt.limit.value.length === 0) {
    stmt.limit = {
      seperator: "",
      value: [{ type: "number", value: maxLimit }],
    };
    return;
  }

  const lastIndex = stmt.limit.value.length - 1;
  const lastValue = stmt.limit.value[lastIndex];
  if (
    lastValue !== undefined &&
    typeof lastValue.value === "number" &&
    lastValue.value > maxLimit
  ) {
    lastValue.value = maxLimit;
  }
}
