import { query } from "@/lib/db/client";

/**
 * A single `sem.*` view/table and its columns, as reflected by Postgres
 * `information_schema.columns` right now. This is the REAL replacement for
 * the old hardcoded placeholder schema description that used to live in
 * `tier3.ts` -- it always matches whatever `sem.*` views actually exist,
 * because it is read live from the database rather than hand-maintained.
 */
export interface SemanticViewInfo {
  /** e.g. "sem.faers_case_summary" */
  schemaQualifiedName: string;
  columns: { name: string; dataType: string }[];
}

interface InformationSchemaColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  ordinal_position: number;
}

/**
 * In-module cache. Deliberately simple for this pass: no TTL, no
 * invalidation hook. The `sem.*` view surface changes only when a migration
 * runs (a deploy-time event, not a request-time one), so a per-process
 * cache that lives until the next restart/deploy is an acceptable
 * simplification -- see the follow-up note in this file's header comment
 * block below (and in tier3.ts) if that assumption ever stops holding.
 */
let cachedCatalog: SemanticViewInfo[] | null = null;

/**
 * Load the current `sem.*` view catalog from Postgres `information_schema`.
 * Result is grouped by table/view name and ordered by column
 * `ordinal_position`, then cached in-module (see `cachedCatalog` above).
 */
export async function loadSemanticViewCatalog(): Promise<SemanticViewInfo[]> {
  if (cachedCatalog) {
    return cachedCatalog;
  }

  const rows = await query<InformationSchemaColumnRow>(
    `SELECT table_name, column_name, data_type, ordinal_position
     FROM information_schema.columns
     WHERE table_schema = 'sem'
     ORDER BY table_name, ordinal_position`,
  );

  const byTable = new Map<string, { name: string; dataType: string }[]>();
  for (const row of rows) {
    const columns = byTable.get(row.table_name) ?? [];
    columns.push({ name: row.column_name, dataType: row.data_type });
    byTable.set(row.table_name, columns);
  }

  cachedCatalog = Array.from(byTable.entries()).map(
    ([tableName, columns]) => ({
      schemaQualifiedName: `sem.${tableName}`,
      columns,
    }),
  );

  return cachedCatalog;
}

/**
 * Render a loaded catalog into a compact text block suitable for embedding
 * in an LLM system prompt, e.g.:
 *   sem.faers_case_summary(safetyreportid text, receivedate date, ...)
 */
export function formatCatalogForPrompt(catalog: SemanticViewInfo[]): string {
  return catalog
    .map((view) => {
      const columnList = view.columns
        .map((c) => `${c.name} ${c.dataType}`)
        .join(", ");
      return `${view.schemaQualifiedName}(${columnList})`;
    })
    .join("\n");
}

/** Every `sem.*` schema-qualified name in a loaded catalog, for use as an
 * `astValidator.ts` allowlist. */
export function catalogTableNames(catalog: SemanticViewInfo[]): string[] {
  return catalog.map((view) => view.schemaQualifiedName);
}

/**
 * Test-only escape hatch: clears the in-module cache so each test file can
 * start from a clean slate regardless of import order. Not used by
 * production code paths.
 */
export function __resetSemanticCatalogCacheForTests(): void {
  cachedCatalog = null;
}
