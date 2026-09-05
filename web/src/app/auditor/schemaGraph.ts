/**
 * Static schema DAG data for the SQL + Schema Auditor tab.
 *
 * Hand-built by reading `db/ddl/003_ontology.sql` (ont.* — Tier 1
 * ontology/governance layer) and `db/ddl/004_semantic_views.sql` (sem.* —
 * Tier 2 curated semantic views), NOT a live DB introspection — that is out
 * of scope for this pass (see the auditor page's own doc comment).
 *
 * Every id below is a real, schema-qualified object name quoted verbatim
 * from those two DDL files as of this writing. If the ddl/ track adds or
 * renames an ont / sem object, this file needs a matching manual update.
 */

export interface SchemaNode {
  id: string;
  tier: "ont" | "sem";
  label: string;
}

export interface SchemaEdge {
  source: string;
  target: string;
  label?: string;
}

// ── ont.* (003_ontology.sql) ────────────────────────────────────────────
export const SCHEMA_NODES: SchemaNode[] = [
  {
    id: "ont.field_label",
    tier: "ont",
    label: "ont.field_label\n(hand-curated column labels)",
  },
  {
    id: "ont.field",
    tier: "ont",
    label: "ont.field\n(live faers.*/ct.* column catalog view)",
  },
  {
    id: "ont.meddra_pt",
    tier: "ont",
    label: "ont.meddra_pt\n(illustrative PT -> body_system)",
  },
  {
    id: "ont.drug_class",
    tier: "ont",
    label: "ont.drug_class\n(ingredient -> pharmacologic class)",
  },
  {
    id: "ont.drug_synonym",
    tier: "ont",
    label: "ont.drug_synonym\n(surface form -> canonical ingredient)",
  },

  // ── sem.* (004_semantic_views.sql) ────────────────────────────────────
  {
    id: "sem.faers_case_summary",
    tier: "sem",
    label: "sem.faers_case_summary\n(one row per FAERS report)",
  },
  {
    id: "sem.faers_drug_reaction",
    tier: "sem",
    label: "sem.faers_drug_reaction\n(flat drug x reaction)",
  },
  {
    id: "sem.trials_summary",
    tier: "sem",
    label: "sem.trials_summary\n(one row per CT.gov study)",
  },
  {
    id: "sem.trials_outcomes",
    tier: "sem",
    label: "sem.trials_outcomes\n(flat nct_id x outcome_measure)",
  },
  {
    id: "sem.drug_trial_ae_link",
    tier: "sem",
    label: "sem.drug_trial_ae_link\n(cross-dataset trial <-> FAERS link)",
  },
];

// Edges = real join relationships declared in the DDL, not invented ones.
// Each `source`/`target` below is verified against a specific JOIN/subquery
// in 003_ontology.sql or 004_semantic_views.sql — see the label for the
// exact join key and the file comment above each edge for the source line.
export const SCHEMA_EDGES: SchemaEdge[] = [
  // 003_ontology.sql: ont.field is a VIEW that LEFT JOINs ont.field_label
  // on (schema_name, table_name, column_name).
  {
    source: "ont.field_label",
    target: "ont.field",
    label: "LEFT JOIN on (schema_name, table_name, column_name)",
  },

  // 004_semantic_views.sql, sem.faers_case_summary: the
  // primary_suspect_classes CTE joins unnested primary-suspect ingredients
  // against ont.drug_class on ingredient.
  {
    source: "sem.faers_case_summary",
    target: "ont.drug_class",
    label: "primary_suspect_ingredients -> ingredient",
  },
  // sem.faers_case_summary: the reactions CTE LEFT JOINs
  // ont.meddra_pt on pt_term = reactionmeddrapt.
  {
    source: "sem.faers_case_summary",
    target: "ont.meddra_pt",
    label: "reactionmeddrapt -> pt_term",
  },

  // sem.faers_drug_reaction: LEFT JOINs ont.meddra_pt the same way, at the
  // flat drug x reaction grain.
  {
    source: "sem.faers_drug_reaction",
    target: "ont.meddra_pt",
    label: "reactionmeddrapt -> pt_term",
  },

  // sem.drug_trial_ae_link: the trial_ingredients CTE selects FROM
  // sem.trials_summary (joined to ct.intervention, out of scope here).
  {
    source: "sem.drug_trial_ae_link",
    target: "sem.trials_summary",
    label: "trial_ingredients CTE (FROM sem.trials_summary)",
  },
  // sem.drug_trial_ae_link: the faers_ingredients CTE selects FROM
  // sem.faers_case_summary.
  {
    source: "sem.drug_trial_ae_link",
    target: "sem.faers_case_summary",
    label: "faers_ingredients CTE (FROM sem.faers_case_summary)",
  },
  // sem.drug_trial_ae_link: both trial_ingredients and faers_ingredients
  // LEFT JOIN ont.drug_synonym (surface_form -> canonical_ingredient) to
  // normalize before matching on canonical_ingredient.
  {
    source: "sem.drug_trial_ae_link",
    target: "ont.drug_synonym",
    label: "surface_form -> canonical_ingredient (both sides)",
  },
];
