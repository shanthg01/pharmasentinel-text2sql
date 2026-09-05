import { query } from "@/lib/db/client";

/**
 * A raw `faers.*`/`ct.*` column ranked as relevant to a natural-language
 * question, via Postgres trigram similarity over `ont.field_label`. This
 * is Tier 4's fallback ranking mechanism -- see `db/ddl/006_field_search.sql`
 * for why (`pg_trgm`, in place of the Cortex Search service used in the
 * Snowflake-based reference architecture).
 */
export interface FieldCandidate {
  /** e.g. "faers.report" */
  schemaQualifiedTable: string;
  columnName: string;
  humanLabel: string;
  /** trigram similarity of `humanLabel` to the question, in [0, 1]. */
  similarity: number;
}

interface FieldLabelSimilarityRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  human_label: string;
  similarity: number;
}

const DEFAULT_LIMIT = 10;

/**
 * Trigram similarity threshold below which a candidate is considered noise
 * rather than a real match. Mirrors the `> 0.1` cutoff baked into the
 * query itself (see `db/ddl/006_field_search.sql` for the backing index).
 */
export const FIELD_SEARCH_SIMILARITY_THRESHOLD = 0.1;

/**
 * Rank `ont.field_label` rows by trigram similarity of their `human_label`
 * to `question`, returning at most `limit` candidates above the
 * similarity threshold, highest similarity first.
 *
 * Requires the `pg_trgm` extension and (for reasonable performance at
 * scale) the GIN trigram index created in `db/ddl/006_field_search.sql`.
 */
export async function searchFieldCandidates(
  question: string,
  limit = DEFAULT_LIMIT,
): Promise<FieldCandidate[]> {
  const rows = await query<FieldLabelSimilarityRow>(
    `SELECT
       schema_name,
       table_name,
       column_name,
       human_label,
       similarity(human_label, $1) AS similarity
     FROM ont.field_label
     WHERE similarity(human_label, $1) > ${FIELD_SEARCH_SIMILARITY_THRESHOLD}
     ORDER BY similarity(human_label, $1) DESC
     LIMIT $2`,
    [question, limit],
  );

  return rows.map((row) => ({
    schemaQualifiedTable: `${row.schema_name}.${row.table_name}`,
    columnName: row.column_name,
    humanLabel: row.human_label,
    similarity: row.similarity,
  }));
}
