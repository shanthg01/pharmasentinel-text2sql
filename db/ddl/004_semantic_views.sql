-- =============================================================================
-- 004_semantic_views.sql
-- Tier 2: curated semantic views (sem schema)
-- =============================================================================
--
-- *** GOVERNANCE NOTE -- this is the Tier 3 grounding boundary ***
--
-- Every view in this file is estimates/curated, denormalized, analysis-ready
-- SQL built on top of the raw faers.*/ct.* tables and the ont.* ontology
-- layer. It contains no raw PII beyond what OpenFDA/ClinicalTrials.gov
-- already publish as de-identified/aggregate case data.
--
-- This is the ONLY set of relations Tier 3 (LLM-driven text-to-SQL
-- generation) is allowed to be grounded on and allowed to generate queries
-- against. Tier 3 -- and Tier 4's normal operation -- must never be pointed
-- at faers.* or ct.* raw tables directly. The single documented exception
-- is the Tier 4 fallback path (owned by another track), which is granted
-- its own explicitly narrower read-only role specifically so that raw-table
-- access is an opt-in escape hatch with its own audit trail, not the
-- default query surface. See db/ddl/005_roles.sql for how that boundary is
-- enforced at the database level via GRANTs, not just by convention.
--
-- Why curate a semantic layer at all instead of pointing an LLM at raw
-- tables with a big prompt describing the schema? Two reasons drove this:
--   1. Raw FAERS/CT.gov tables require multi-way joins and FDA-specific
--      encoding knowledge (e.g. drugcharacterization='1') to answer even
--      simple questions correctly; baking that into governed views means
--      the LLM can't get the join wrong because it never writes the join.
--   2. A stable, documented, narrow view surface is something a human
--      reviewer can actually read end-to-end and reason about what an LLM
--      is capable of returning -- a moving target of 10+ raw tables is not.
-- =============================================================================

-- =============================================================================
-- sem.faers_case_summary -- one row per FAERS safety report
-- =============================================================================
--
-- Aggregation strategy: each of the three "many per report" raw tables
-- (drug filtered to primary suspects, drug joined to drug_class, reaction
-- joined to meddra_pt) is pre-aggregated to exactly one row per
-- safetyreportid in its own CTE *before* being joined back to the report,
-- specifically to avoid the classic multi-child-table fanout bug where
-- joining two one-to-many tables directly multiplies row counts against
-- each other. faers.patient is genuinely 1:1 with faers.report today, so it
-- is safe to LEFT JOIN directly without pre-aggregating.
CREATE OR REPLACE VIEW sem.faers_case_summary AS
WITH primary_suspects AS (
    -- drugcharacterization = '1' is the FDA code for "suspect" drug (as
    -- opposed to '2' concomitant / '3' interacting) -- see comment on
    -- faers.drug.drugcharacterization in 001_raw_faers.sql. A report can
    -- have more than one primary suspect drug, hence arrays rather than
    -- scalars.
    SELECT
        d.safetyreportid,
        array_agg(DISTINCT d.drugname) FILTER (WHERE d.drugname IS NOT NULL) AS primary_suspect_drugs,
        array_agg(DISTINCT d.active_ingredient) FILTER (WHERE d.active_ingredient IS NOT NULL) AS primary_suspect_ingredients
    FROM faers.drug d
    WHERE d.drugcharacterization = '1'
    GROUP BY d.safetyreportid
),
primary_suspect_classes AS (
    -- Expand each report's primary suspect ingredients and look up class
    -- membership, then re-collapse to one row per report. LEFT JOIN to
    -- ont.drug_class so an unmapped ingredient doesn't drop the report --
    -- it just contributes no class.
    SELECT
        ps.safetyreportid,
        array_agg(DISTINCT dc.drug_class) FILTER (WHERE dc.drug_class IS NOT NULL) AS primary_suspect_drug_classes
    FROM primary_suspects ps
    -- Explicit column alias (ingredient_value), distinct from
    -- ont.drug_class.ingredient -- a bare `AS ingredient` here makes the
    -- unnested column and dc.ingredient both resolve to the same bare name
    -- "ingredient" in the ON clause below, which Postgres rejects as
    -- ambiguous.
    CROSS JOIN LATERAL unnest(ps.primary_suspect_ingredients) AS u(ingredient_value)
    LEFT JOIN ont.drug_class dc ON dc.ingredient = u.ingredient_value
    GROUP BY ps.safetyreportid
),
reactions AS (
    -- reaction_terms and reaction_body_systems are two separate DISTINCT
    -- arrays rather than one array of (term, body_system) pairs. That
    -- trades positional term<->system alignment for simplicity, which is
    -- the right trade here: every consumer we have (Tier 3 filtering,
    -- analyst dashboards) asks "does this case involve a cardiac reaction"
    -- or "what terms were reported", never "which specific term maps to
    -- which specific system for this one case" in a way that requires
    -- positional pairing. If that need arises, prefer a dedicated
    -- (safetyreportid, reactionmeddrapt, body_system) view -- which already
    -- exists in spirit via sem.faers_drug_reaction -- over overloading this
    -- one.
    SELECT
        rx.safetyreportid,
        array_agg(DISTINCT rx.reactionmeddrapt) FILTER (WHERE rx.reactionmeddrapt IS NOT NULL) AS reaction_terms,
        array_agg(DISTINCT mp.body_system) FILTER (WHERE mp.body_system IS NOT NULL) AS reaction_body_systems,
        bool_or(mp.is_serious_category) AS any_reaction_serious_category
    FROM faers.reaction rx
    LEFT JOIN ont.meddra_pt mp ON mp.pt_term = rx.reactionmeddrapt
    GROUP BY rx.safetyreportid
)
SELECT
    rpt.safetyreportid,
    rpt.receivedate,
    -- Seriousness flags are passed through as-is. FAERS has NO CTCAE
    -- (Common Terminology Criteria for Adverse Events) numeric grade field
    -- -- these booleans are the closest available severity signal and are
    -- used throughout sem.* strictly as a documented proxy, never silently
    -- relabeled as a "Grade". See sem.drug_trial_ae_link below and
    -- docs/design/data-layer.md for the full discussion.
    rpt.serious,
    rpt.seriousnessdeath,
    rpt.seriousnesshospitalization,
    rpt.seriousnesslifethreatening,
    rpt.seriousnessdisabling,
    rpt.reporttype,
    rpt.companynumb,
    rpt.primarysource_qualification,
    rpt.occurcountry,
    pat.patientonsetage,
    pat.patientonsetageunit,
    pat.patientsex,
    pat.patientweight,
    ps.primary_suspect_drugs,
    ps.primary_suspect_ingredients,
    psc.primary_suspect_drug_classes,
    rx.reaction_terms,
    rx.reaction_body_systems,
    rx.any_reaction_serious_category
FROM faers.report rpt
LEFT JOIN faers.patient pat            ON pat.safetyreportid = rpt.safetyreportid
LEFT JOIN primary_suspects ps          ON ps.safetyreportid  = rpt.safetyreportid
LEFT JOIN primary_suspect_classes psc  ON psc.safetyreportid = rpt.safetyreportid
LEFT JOIN reactions rx                 ON rx.safetyreportid  = rpt.safetyreportid;

COMMENT ON VIEW sem.faers_case_summary IS 'One row per FAERS safetyreportid: report + patient + primary-suspect-drug (drugcharacterization=''1'') + drug class + aggregated reaction terms/body systems. Tier 3 grounding surface.';

-- =============================================================================
-- sem.faers_drug_reaction -- flat (safetyreportid, drugname, reactionmeddrapt)
-- =============================================================================
--
-- Deliberately NOT filtered to primary suspect drugs and NOT deduplicated:
-- this is every drug on a report crossed with every reaction on that same
-- report, which is what "drug x reaction analysis" (e.g. disproportionality
-- signal-detection style counting) needs. Callers who only want the primary
-- suspect drug's reactions should filter on drugcharacterization = '1' or
-- use sem.faers_case_summary instead. Co-occurrence within a report is NOT
-- evidence of causation -- that caveat belongs in any consumer-facing text,
-- not just this comment.
CREATE OR REPLACE VIEW sem.faers_drug_reaction AS
SELECT
    rpt.safetyreportid,
    rpt.receivedate,
    rpt.serious,
    d.drugname,
    d.active_ingredient,
    d.drugcharacterization,
    rx.reactionmeddrapt,
    rx.reactionoutcome,
    mp.body_system,
    mp.is_serious_category
FROM faers.report rpt
JOIN faers.drug d      ON d.safetyreportid  = rpt.safetyreportid
JOIN faers.reaction rx ON rx.safetyreportid = rpt.safetyreportid
LEFT JOIN ont.meddra_pt mp ON mp.pt_term = rx.reactionmeddrapt;

COMMENT ON VIEW sem.faers_drug_reaction IS 'Flat drug x reaction grain (safetyreportid, drugname, reactionmeddrapt) for co-occurrence/signal-detection style analysis. Not filtered to primary suspect drugs; not causal evidence.';

-- =============================================================================
-- sem.trials_summary -- one row per ClinicalTrials.gov study
-- =============================================================================
--
-- Uses correlated subqueries (rather than joining ct.condition and
-- ct.intervention directly into one GROUP BY) for the same fanout-avoidance
-- reason described on sem.faers_case_summary: joining two independent
-- one-to-many child tables in the same query multiplies rows against each
-- other before aggregation. array_agg(DISTINCT ...) would still produce the
-- *correct* array contents even under that fanout, but the correlated
-- subquery form is clearer to read and cheaper to execute (each subquery
-- can use the nct_id index on its own child table independently).
CREATE OR REPLACE VIEW sem.trials_summary AS
SELECT
    s.nct_id,
    s.brief_title,
    s.overall_status,
    s.phase,
    s.study_type,
    s.enrollment_count,
    s.start_date,
    s.primary_completion_date,
    s.lead_sponsor,
    (
        SELECT array_agg(DISTINCT c.condition_name)
        FROM ct.condition c
        WHERE c.nct_id = s.nct_id
    ) AS conditions,
    (
        SELECT array_agg(DISTINCT i.intervention_name)
        FROM ct.intervention i
        WHERE i.nct_id = s.nct_id
    ) AS interventions
FROM ct.study s;

COMMENT ON VIEW sem.trials_summary IS 'One row per nct_id: study fields + aggregated condition names + aggregated intervention names. Tier 3 grounding surface.';

-- =============================================================================
-- sem.trials_outcomes -- flat nct_id x outcome_measure
-- =============================================================================
CREATE OR REPLACE VIEW sem.trials_outcomes AS
SELECT
    s.nct_id,
    s.brief_title,
    s.phase,
    s.overall_status,
    om.outcome_type,
    om.measure,
    om.time_frame
FROM ct.study s
JOIN ct.outcome_measure om ON om.nct_id = s.nct_id;

COMMENT ON VIEW sem.trials_outcomes IS 'Flat grain (nct_id, outcome_measure) with trial context columns for outcome-measure-level analysis.';

-- =============================================================================
-- sem.drug_trial_ae_link -- the cross-dataset view
-- =============================================================================
--
-- This is the view that makes a question like "Phase 3 oncology trials
-- evaluating kinase inhibitors with cardiac AEs" answerable in one query:
-- it links a trial's registered interventions to FAERS primary-suspect-drug
-- cases through a shared canonical ingredient, so trial phase/condition/
-- intervention can be filtered alongside FAERS reaction body_system and
-- seriousness in the same WHERE clause.
--
-- Ingredient matching goes through ont.drug_synonym in both directions
-- (trial intervention_name -> canonical ingredient, FAERS
-- active_ingredient -> canonical ingredient) because trial sponsors and
-- FAERS reporters frequently use different surface forms (brand name,
-- generic name, sponsor code name, misspellings) for the same substance.
-- Where no synonym row exists yet, we fall back to lower(name) so an
-- exact-case-insensitive match still works rather than silently dropping
-- the row -- this is a deliberately soft fallback, not a claim that
-- lower(name) is a reliable normalization in general (see
-- docs/design/data-layer.md, "drug name variants").
--
-- *** SEVERITY PROXY WARNING ***
-- FAERS has NO CTCAE (Common Terminology Criteria for Adverse Events)
-- grade field. The seriousness flags exposed here (serious,
-- seriousnessdeath, seriousnesshospitalization, seriousnesslifethreatening,
-- seriousnessdisabling) are FDA regulatory seriousness criteria, used
-- throughout this platform as an explicit, documented PROXY for adverse
-- event severity. They must never be presented, mapped, or silently
-- equated to a numeric CTCAE "Grade" (e.g. Grade 3/4) -- that is a
-- different, incompatible severity scale used in clinical trial AE
-- reporting, and no crosswalk between the two exists in this dataset.
-- Any Tier 3 prompt or Tier 4 fallback response surfacing these fields
-- should describe them as "FDA seriousness criteria", not "AE grade".
CREATE OR REPLACE VIEW sem.drug_trial_ae_link AS
WITH trial_ingredients AS (
    SELECT
        ts.nct_id,
        ts.brief_title,
        ts.overall_status,
        ts.phase,
        ts.study_type,
        ts.conditions,
        i.intervention_type,
        i.intervention_name,
        COALESCE(syn.canonical_ingredient, lower(i.intervention_name)) AS canonical_ingredient
    FROM sem.trials_summary ts
    JOIN ct.intervention i ON i.nct_id = ts.nct_id
    LEFT JOIN ont.drug_synonym syn ON syn.surface_form = lower(i.intervention_name)
),
faers_ingredients AS (
    -- Unnest each case's primary suspect ingredients so a report with
    -- multiple primary suspects can match on any of them.
    SELECT
        fcs.safetyreportid,
        fcs.receivedate,
        fcs.serious,
        fcs.seriousnessdeath,
        fcs.seriousnesshospitalization,
        fcs.seriousnesslifethreatening,
        fcs.seriousnessdisabling,
        fcs.reaction_terms,
        fcs.reaction_body_systems,
        fcs.primary_suspect_drug_classes,
        COALESCE(syn.canonical_ingredient, lower(raw_ingredient)) AS canonical_ingredient
    FROM sem.faers_case_summary fcs
    CROSS JOIN LATERAL unnest(fcs.primary_suspect_ingredients) AS raw_ingredient
    LEFT JOIN ont.drug_synonym syn ON syn.surface_form = lower(raw_ingredient)
    WHERE fcs.primary_suspect_ingredients IS NOT NULL
)
SELECT
    ti.nct_id,
    ti.brief_title,
    ti.overall_status,
    ti.phase,
    ti.study_type,
    ti.conditions,
    ti.intervention_type,
    ti.intervention_name,
    ti.canonical_ingredient,
    fi.safetyreportid,
    fi.receivedate                       AS faers_receivedate,
    fi.serious,
    fi.seriousnessdeath,
    fi.seriousnesshospitalization,
    fi.seriousnesslifethreatening,
    fi.seriousnessdisabling,
    fi.reaction_terms,
    fi.reaction_body_systems,
    fi.primary_suspect_drug_classes      AS faers_drug_classes
FROM trial_ingredients ti
JOIN faers_ingredients fi ON fi.canonical_ingredient = ti.canonical_ingredient;

COMMENT ON VIEW sem.drug_trial_ae_link IS 'Cross-dataset link: trial interventions (ont.drug_synonym-normalized) joined to FAERS primary-suspect-drug cases on canonical ingredient. Seriousness flags are a documented proxy for AE severity -- FAERS has no CTCAE grade field. See file header before using or extending.';
