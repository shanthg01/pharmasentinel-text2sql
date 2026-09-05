-- =============================================================================
-- 003_ontology.sql
-- Tier 1: ontology / governance layer (ont schema)
-- =============================================================================
--
-- This is metadata *about* the raw and semantic data, not the data itself:
-- a catalog of what each raw column means in plain English, plus a handful
-- of curated lookup tables (MedDRA-illustrative term buckets, drug class
-- membership, drug name synonyms) that both the semantic views (sem.*) and
-- Tier 3/4 query generation rely on for grounding and normalization.
-- =============================================================================

-- =============================================================================
-- ont.field_label / ont.field -- human-readable catalog of raw columns
-- =============================================================================
--
-- ont.field_label is a small manually-curated table (schema, table, column)
-- -> (human_label, description). We do NOT try to auto-populate this for
-- every column in faers.*/ct.* -- that would just be information_schema
-- with extra steps and would drift the moment someone adds a column. It's
-- deliberately a hand-maintained subset covering the columns most likely to
-- matter for Tier 3 prompt grounding and analyst onboarding; unlabeled
-- columns simply show NULL human_label/description in the ont.field view.
CREATE TABLE IF NOT EXISTS ont.field_label (
    schema_name   text NOT NULL,
    table_name    text NOT NULL,
    column_name   text NOT NULL,
    human_label   text NOT NULL,
    description   text,
    PRIMARY KEY (schema_name, table_name, column_name)
);

COMMENT ON TABLE ont.field_label IS 'Hand-curated human labels/descriptions for a subset of raw faers.*/ct.* columns. Not exhaustive by design -- see file header.';

-- ont.field is a VIEW, not a materialized table: it always reflects the
-- live raw schema (via information_schema) left-joined to whatever labels
-- have been curated so far, so it can never go stale relative to actual
-- column additions/drops in faers.*/ct.*.
CREATE OR REPLACE VIEW ont.field AS
SELECT
    c.table_schema  AS schema_name,
    c.table_name,
    c.column_name,
    c.data_type,
    c.ordinal_position,
    fl.human_label,
    fl.description
FROM information_schema.columns c
LEFT JOIN ont.field_label fl
    ON  fl.schema_name = c.table_schema
    AND fl.table_name  = c.table_name
    AND fl.column_name = c.column_name
WHERE c.table_schema IN ('faers', 'ct')
ORDER BY c.table_schema, c.table_name, c.ordinal_position;

COMMENT ON VIEW ont.field IS 'Live catalog of raw faers.*/ct.* columns (from information_schema) left-joined to curated human labels in ont.field_label. Refreshes automatically as raw tables change; labels must be added by hand.';

-- Seed a handful of the most important columns as a worked example. This is
-- intentionally not comprehensive -- extend as Tier 3 prompt grounding needs
-- more coverage.
INSERT INTO ont.field_label (schema_name, table_name, column_name, human_label, description) VALUES
    ('faers', 'report',   'safetyreportid',             'FAERS Case ID',        'Unique identifier for a single adverse event case as assigned by FDA FAERS.'),
    ('faers', 'report',   'serious',                     'Serious Case Flag',    'True if the case met any FDA seriousness criterion (death, hospitalization, life-threatening, disabling, or other). Used as an AE-severity proxy in the absence of CTCAE grading.'),
    ('faers', 'report',   'receivedate',                 'FDA Received Date',   'Date FDA received the safety report, not the date the event occurred.'),
    ('faers', 'drug',     'drugcharacterization',        'Drug Role',            'Reporter-assigned role of the drug in the case: 1=suspect, 2=concomitant, 3=interacting.'),
    ('faers', 'drug',     'active_ingredient',           'Active Ingredient',   'ETL-normalized active ingredient name, when resolvable from the verbatim reported drug name.'),
    ('faers', 'reaction', 'reactionmeddrapt',            'Reaction (MedDRA PT)', 'Adverse reaction as a MedDRA Preferred Term string, verbatim as reported to FDA (not a licensed hierarchy reference -- see ont.meddra_pt).'),
    ('ct',    'study',    'nct_id',                       'NCT Number',          'Unique ClinicalTrials.gov trial identifier.'),
    ('ct',    'study',    'phase',                       'Trial Phase',         'Clinical trial phase as registered (PHASE1-4, NA for non-phase studies).'),
    ('ct',    'intervention', 'intervention_name',        'Intervention Name',   'Drug/biologic/device/procedure name as registered by the trial sponsor; may be a brand, generic, or investigational code name.')
ON CONFLICT (schema_name, table_name, column_name) DO NOTHING;

-- =============================================================================
-- ont.meddra_pt -- curated MedDRA Preferred Term -> body-system bucket
-- =============================================================================
--
-- *** LICENSING NOTE -- READ BEFORE EXTENDING THIS TABLE ***
--
-- The full MedDRA terminology (its System Organ Class / High Level Group
-- Term / High Level Term / Preferred Term / Lowest Level Term hierarchy) is
-- proprietary and requires a paid subscription through the MedDRA MSSO
-- (https://www.meddra.org/). We do NOT ship, embed, or reconstruct that
-- licensed hierarchy anywhere in this repository.
--
-- This table is a small, HAND-CURATED, ILLUSTRATIVE subset of Preferred-Term
-- -like strings bucketed into informal body-system categories, covering
-- roughly cardiac, hepatic, oncology-relevant, and a few other commonly
-- discussed adverse event areas. It exists so the sem.* views and Tier 3
-- demo queries have *something* to group reactions by; it is not clinically
-- authoritative, not comprehensive, and must never be presented to end
-- users as "the MedDRA hierarchy."
--
-- If/when this project has access to a real MedDRA subscription, this table
-- should be replaced or extended with the licensed SOC/HLGT/HLT/PT/LLT
-- mapping (typically loaded from the MedDRA ASCII distribution files), and
-- the body_system column here can be superseded by a proper SOC join. Until
-- then, treat every row below as "illustrative bucket", not "ground truth".
CREATE TABLE IF NOT EXISTS ont.meddra_pt (
    pt_term               text PRIMARY KEY,
    body_system           text NOT NULL,
    is_serious_category   boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE ont.meddra_pt IS 'ILLUSTRATIVE ONLY, NOT LICENSED MEDDRA: small hand-curated PT -> body-system bucket lookup covering cardiac/hepatic/oncology-relevant terms. See table-level comment in 003_ontology.sql for full licensing rationale before extending.';

-- =============================================================================
-- ont.drug_class -- ingredient -> pharmacologic class
-- =============================================================================
--
-- Many-to-many on purpose (PRIMARY KEY on the pair): a single ingredient can
-- legitimately belong to more than one class label in common usage (e.g. a
-- kinase inhibitor that is also described as a "targeted therapy"), and we'd
-- rather allow multiple rows than force an arbitrary single-class model.
CREATE TABLE IF NOT EXISTS ont.drug_class (
    ingredient   text NOT NULL,
    drug_class   text NOT NULL,
    PRIMARY KEY (ingredient, drug_class)
);

COMMENT ON TABLE ont.drug_class IS 'Curated ingredient -> pharmacologic class mapping (e.g. imatinib -> kinase inhibitor). Many-to-many: an ingredient may appear under more than one class.';

CREATE INDEX IF NOT EXISTS idx_ont_drug_class_drug_class ON ont.drug_class (drug_class);

-- =============================================================================
-- ont.drug_synonym -- surface form -> canonical ingredient normalization
-- =============================================================================
--
-- Brand names, generic names, and common misspellings all resolve to a
-- single canonical_ingredient. surface_form is the PK (each spelling maps to
-- exactly one canonical ingredient) while canonical_ingredient itself can
-- naturally repeat across many rows (a drug can have many brand names).
-- This table is read by both the ETL track (to populate
-- faers.drug.active_ingredient / normalize ct.intervention_name at load
-- time) and, later, by the Tier 4 fallback path when it needs to resolve a
-- user-typed drug name against raw tables directly.
CREATE TABLE IF NOT EXISTS ont.drug_synonym (
    surface_form           text PRIMARY KEY,
    canonical_ingredient   text NOT NULL
);

COMMENT ON TABLE ont.drug_synonym IS 'Brand/generic/misspelling surface form -> canonical active ingredient. Used by ETL for normalization and by Tier 4 fallback for drug-name resolution against raw tables.';

CREATE INDEX IF NOT EXISTS idx_ont_drug_synonym_canonical_ingredient ON ont.drug_synonym (canonical_ingredient);
