import { NextResponse } from "next/server";
import { Parser } from "node-sql-parser";

export interface InspectSqlRequestBody {
  sql: string;
}

export interface InspectSqlResponseBody {
  tables: string[];
}

// A single shared parser instance, same rationale as astValidator.ts's
// module-level `parser` — node-sql-parser's Parser is stateless per-call.
const parser = new Parser();

/**
 * POST /api/auditor/inspect-sql
 *
 * Body: `{ sql: string }`
 * Response: `{ tables: string[] }` — schema-qualified (or bare) table/view
 * names the query references, in the same `"schema.table"` normalized form
 * `astValidator.ts` uses for its allowlist comparison (see
 * `normalizeTableListEntry` there — duplicated below rather than imported,
 * since it isn't exported and this route only READS astValidator.ts's
 * technique, per this track's scope).
 *
 * This route does NOT re-run allowlist/mutation validation — that gate
 * already runs server-side inside `/api/chat` (via `generateTier3Sql` /
 * `tier4Fallback`, both of which call `validateSql`) before any SQL is ever
 * returned to a client. This route exists purely so the Auditor UI can
 * learn which `ont.*`/`sem.*` objects a query touched, to highlight them on
 * the schema DAG — it will happily extract tables from SQL that wouldn't
 * pass the allowlist (e.g. to show why a Tier 4 raw-table reference isn't
 * on the schema graph at all), which is a different job than validation.
 */
export async function POST(request: Request): Promise<Response> {
  let body: Partial<InspectSqlRequestBody>;
  try {
    body = (await request.json()) as Partial<InspectSqlRequestBody>;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const sql = body.sql?.trim();
  if (!sql) {
    return NextResponse.json(
      { error: "Missing required field: sql" },
      { status: 400 },
    );
  }

  try {
    const tableListEntries = parser.tableList(sql, { database: "postgresql" });
    const tables = tableListEntries.map(normalizeTableListEntry);
    const response: InspectSqlResponseBody = { tables };
    return NextResponse.json(response);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to parse SQL: ${(err as Error).message}` },
      { status: 400 },
    );
  }
}

/**
 * `node-sql-parser`'s `tableList()` entries look like
 * `"select::<schema>::<table>"`, where `<schema>` is the literal string
 * `"null"` when the query didn't schema-qualify the table. Normalize to
 * `"schema.table"` (or bare `"table"`) — identical logic to
 * `normalizeTableListEntry` in `web/src/lib/sql/astValidator.ts`, kept in
 * sync by hand since that helper isn't exported from there.
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
