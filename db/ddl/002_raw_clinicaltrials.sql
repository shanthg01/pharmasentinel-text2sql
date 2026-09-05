-- =============================================================================
-- 002_raw_clinicaltrials.sql
-- Raw ClinicalTrials.gov v2 API study tables
-- =============================================================================
--
-- Shape follows the ClinicalTrials.gov API v2 "studies" resource
-- (https://clinicaltrials.gov/data-api/api), flattened by the ETL track
-- from the nested protocolSection JSON into one parent + three child
-- tables. nct_id (the NCT number, e.g. 'NCT01234567') is the natural key
-- ClinicalTrials.gov assigns and is stable across API versions, so it's
-- used as the primary key here rather than an internal surrogate.
--
-- As with faers.*, these are RAW tables: verbatim field values (modulo
-- type-casting), no dedup or normalization. Normalization of intervention
-- names against FAERS drug names happens in ont.drug_synonym / the
-- sem.drug_trial_ae_link view, not here.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ct.study -- one row per registered trial
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct.study (
    nct_id                        text PRIMARY KEY,
    brief_title                   text,
    overall_status                text,   -- e.g. 'RECRUITING', 'COMPLETED', 'TERMINATED'
    phase                         text,   -- e.g. 'PHASE1', 'PHASE2', 'PHASE3', 'PHASE4', 'NA'
    study_type                    text,   -- e.g. 'INTERVENTIONAL', 'OBSERVATIONAL'
    enrollment_count               integer,
    start_date                    date,
    primary_completion_date        date,
    lead_sponsor                  text
);

COMMENT ON TABLE ct.study IS 'Raw ClinicalTrials.gov v2 study record, one row per nct_id. Loaded verbatim (modulo type-casting) from the /studies API.';
COMMENT ON COLUMN ct.study.phase IS 'Raw CT.gov phase enum string, kept as-is (not decoded to a friendlier label) so ETL does not have to own a phase taxonomy; sem.* views may relabel for presentation.';

-- ---------------------------------------------------------------------------
-- ct.condition -- conditions/diseases a trial is studying (many per trial)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct.condition (
    id             bigserial PRIMARY KEY,
    nct_id          text NOT NULL REFERENCES ct.study (nct_id),
    condition_name  text
);

COMMENT ON TABLE ct.condition IS 'Raw condition/disease terms studied by a trial, one row per (trial, condition).';

CREATE INDEX IF NOT EXISTS idx_ct_condition_nct_id ON ct.condition (nct_id);
CREATE INDEX IF NOT EXISTS idx_ct_condition_condition_name ON ct.condition (condition_name);

-- ---------------------------------------------------------------------------
-- ct.intervention -- drugs/procedures/devices under study (many per trial)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct.intervention (
    id                    bigserial PRIMARY KEY,
    nct_id                 text NOT NULL REFERENCES ct.study (nct_id),
    intervention_type      text,   -- e.g. 'DRUG', 'BIOLOGICAL', 'DEVICE', 'PROCEDURE'
    intervention_name      text
);

COMMENT ON TABLE ct.intervention IS 'Raw intervention entries per trial. intervention_name is free text as registered by the sponsor -- brand/generic/code-name variants are normalized downstream via ont.drug_synonym, not here.';

CREATE INDEX IF NOT EXISTS idx_ct_intervention_nct_id ON ct.intervention (nct_id);
CREATE INDEX IF NOT EXISTS idx_ct_intervention_intervention_name ON ct.intervention (intervention_name);

-- ---------------------------------------------------------------------------
-- ct.outcome_measure -- prespecified primary/secondary outcome measures
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct.outcome_measure (
    id             bigserial PRIMARY KEY,
    nct_id          text NOT NULL REFERENCES ct.study (nct_id),
    outcome_type    text,   -- 'primary' or 'secondary'
    measure         text,
    time_frame      text
);

COMMENT ON TABLE ct.outcome_measure IS 'Raw prespecified outcome measures per trial, one row per measure as registered (not per reported result -- CT.gov results reporting is a separate, not-yet-modeled endpoint).';

CREATE INDEX IF NOT EXISTS idx_ct_outcome_measure_nct_id ON ct.outcome_measure (nct_id);
