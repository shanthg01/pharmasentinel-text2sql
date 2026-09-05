-- =============================================================================
-- 001_raw_faers.sql
-- Raw OpenFDA FAERS (FDA Adverse Event Reporting System) drug-event tables
-- =============================================================================
--
-- Shape follows the OpenFDA "drug event" endpoint JSON reasonably closely
-- (https://open.fda.gov/apis/drug/event/) rather than the original FDA
-- ASCII/SGML FAERS quarterly extract layout, since that is what the ETL
-- track is ingesting from. One safety report (safetyreportid) is the FAERS
-- unit of a single adverse event case and can carry multiple drugs and
-- multiple reactions, hence the one-to-many child tables below.
--
-- These are RAW tables: no dedup, no normalization, no derived columns.
-- FAERS is well known to contain duplicate and later-nullified reports
-- (see docs/design/data-layer.md, "known data-quality gaps") -- resolving
-- that is a semantic-layer concern (sem.*), not something we bake into
-- ingestion, so downstream consumers can see exactly what OpenFDA returned.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- faers.report -- one row per FAERS safety report (the adverse event "case")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faers.report (
    safetyreportid                  text PRIMARY KEY,
    receivedate                     date,
    -- OpenFDA encodes these seriousness flags as "1"/"2" strings in the raw
    -- JSON; ETL casts to boolean (true = criterion met) so downstream SQL
    -- doesn't have to know that FDA convention. See sem.faers_case_summary
    -- and sem.drug_trial_ae_link for how these become the AE-severity proxy.
    serious                          boolean,
    seriousnessdeath                 boolean,
    seriousnesshospitalization       boolean,
    seriousnesslifethreatening       boolean,
    seriousnessdisabling             boolean,
    reporttype                       text,   -- e.g. 'Expedited', 'Direct', 'Periodic'
    companynumb                      text,   -- manufacturer's internal case number
    primarysource_qualification      text,   -- reporter type: physician, pharmacist, consumer, etc.
    occurcountry                     text    -- ISO-ish country code as reported to FDA
);

COMMENT ON TABLE faers.report IS 'Raw FAERS safety report header, one row per safetyreportid. Loaded verbatim from OpenFDA drug-event JSON.';
COMMENT ON COLUMN faers.report.serious IS 'True if report was flagged serious by any criterion. Used only as a documented severity proxy -- FAERS has no CTCAE grade.';

-- ---------------------------------------------------------------------------
-- faers.patient -- demographic detail attached to the report
-- ---------------------------------------------------------------------------
-- Modeled 1:1 with report today (OpenFDA nests a single "patient" object per
-- safety report), but kept as its own table rather than columns on
-- faers.report because it is a logically distinct part of the source JSON
-- and the ETL track loads it independently.
CREATE TABLE IF NOT EXISTS faers.patient (
    safetyreportid       text PRIMARY KEY REFERENCES faers.report (safetyreportid),
    patientonsetage      numeric,
    patientonsetageunit  text,   -- FAERS age unit code, e.g. 'Year', 'Month' (post-ETL-decode)
    patientsex           text,   -- 'Male' / 'Female' / 'Unknown' (post-ETL-decode)
    patientweight         numeric
);

COMMENT ON TABLE faers.patient IS 'Raw FAERS patient demographics, one row per safetyreportid.';

-- PRIMARY KEY (not just an index) is deliberate: the ETL loader's
-- ON CONFLICT (safetyreportid) upsert (etl/faers/load_reports.py) needs a
-- real unique constraint on this column to target, and the 1:1 modeling
-- note above means a PK is also the honest cardinality statement.

-- ---------------------------------------------------------------------------
-- faers.drug -- drugs implicated in a report (many per report)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faers.drug (
    id                        bigserial PRIMARY KEY,
    safetyreportid            text NOT NULL REFERENCES faers.report (safetyreportid),
    drugname                  text,   -- verbatim reported name (brand, generic, or misspelled)
    active_ingredient         text,   -- ETL-normalized active ingredient, when resolvable
    -- '1' = suspect, '2' = concomitant, '3' = interacting -- kept as raw FDA
    -- code (text) rather than decoded, since the semantic layer only ever
    -- needs to filter on '1' (primary suspect) and we don't want ETL to have
    -- to guess a label taxonomy that isn't ours to own.
    drugcharacterization       text,
    drugdosagetext             text,
    drugindication             text,
    drugadministrationroute    text
);

COMMENT ON TABLE faers.drug IS 'Raw FAERS drug entries per report; drugcharacterization=''1'' denotes the primary suspect drug.';
COMMENT ON COLUMN faers.drug.active_ingredient IS 'ETL-normalized ingredient name where resolvable from drugname; may be NULL for unresolved/free-text entries. ont.drug_synonym provides a further normalization pass for Tier 3/4 querying.';

CREATE INDEX IF NOT EXISTS idx_faers_drug_safetyreportid ON faers.drug (safetyreportid);
CREATE INDEX IF NOT EXISTS idx_faers_drug_drugname ON faers.drug (drugname);

-- ---------------------------------------------------------------------------
-- faers.reaction -- adverse reactions reported (many per report)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faers.reaction (
    id                    bigserial PRIMARY KEY,
    safetyreportid         text NOT NULL REFERENCES faers.report (safetyreportid),
    reactionmeddrapt       text,   -- MedDRA Preferred Term as reported (verbatim string, not FK to a license)
    reactionoutcome        text    -- e.g. 'Recovered', 'Fatal', 'Not Recovered' (FDA outcome code, post-ETL-decode)
);

COMMENT ON TABLE faers.reaction IS 'Raw FAERS reaction entries per report. reactionmeddrapt is a free-text PT string as supplied by OpenFDA, not a licensed MedDRA hierarchy reference -- see ont.meddra_pt.';

CREATE INDEX IF NOT EXISTS idx_faers_reaction_safetyreportid ON faers.reaction (safetyreportid);
CREATE INDEX IF NOT EXISTS idx_faers_reaction_reactionmeddrapt ON faers.reaction (reactionmeddrapt);
