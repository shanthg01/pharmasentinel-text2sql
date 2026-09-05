/**
 * Verified-query cache: a small set of hand-written (question, SQL) pairs
 * that a human has already checked are correct against the real `sem.*`
 * semantic layer. When a user's question matches one of these, Tier 3 can
 * skip the LLM call entirely and return known-good SQL.
 *
 * *** DOCUMENTED SIMPLIFICATION ***
 * `findVerifiedMatch` below does case-insensitive, whitespace-normalized
 * EXACT string matching only. A real verified-query cache would want
 * fuzzy/semantic matching (e.g. embedding similarity, or at minimum
 * trigram similarity the way `lib/sql/fieldSearch.ts` does for Tier 4
 * columns) so that "How many serious AE reports mention imatinib?" also
 * hits the seed entry below written as "How many serious adverse event
 * reports mention imatinib?". That is a documented follow-up, not built in
 * this pass -- don't over-engineer a real similarity search here.
 */

export interface VerifiedQuery {
  question: string;
  sql: string;
}

/**
 * Seed verified queries, hand-written against the real `sem.*` views in
 * `db/ddl/004_semantic_views.sql`. Each of these has been checked to parse
 * and validate cleanly through `lib/sql/astValidator.ts`.
 */
export const SEED_VERIFIED_QUERIES: VerifiedQuery[] = [
  {
    question: "How many serious adverse event reports mention imatinib?",
    sql: `SELECT count(*) AS report_count
FROM sem.faers_case_summary
WHERE serious = true
  AND 'imatinib' = ANY (primary_suspect_ingredients)`,
  },
  {
    question: "What are the most common reactions reported for aspirin?",
    sql: `SELECT reactionmeddrapt, count(*) AS reaction_count
FROM sem.faers_drug_reaction
WHERE active_ingredient = 'aspirin'
GROUP BY reactionmeddrapt
ORDER BY reaction_count DESC
LIMIT 20`,
  },
  {
    question: "List Phase 3 clinical trials studying imatinib.",
    sql: `SELECT nct_id, brief_title, overall_status, conditions
FROM sem.trials_summary
WHERE phase = 'PHASE3'
  AND 'imatinib' = ANY (interventions)`,
  },
  {
    question:
      "Which Phase 3 oncology trials of kinase inhibitors have linked cardiac adverse events?",
    sql: `SELECT DISTINCT nct_id, brief_title, intervention_name, canonical_ingredient
FROM sem.drug_trial_ae_link
WHERE phase = 'PHASE3'
  AND 'cardiac' = ANY (reaction_body_systems)`,
  },
];

/**
 * Case-insensitive, whitespace/punctuation-normalized EXACT match against a
 * candidate list. See the module-level "DOCUMENTED SIMPLIFICATION" comment
 * above -- this is intentionally not fuzzy/semantic matching.
 */
export function findVerifiedMatch(
  question: string,
  candidates: VerifiedQuery[],
): VerifiedQuery | null {
  const normalizedQuestion = normalize(question);
  const match = candidates.find(
    (candidate) => normalize(candidate.question) === normalizedQuestion,
  );
  return match ?? null;
}

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?.!]+$/, "");
}
