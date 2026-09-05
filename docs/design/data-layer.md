# PharmaSentinel Data Layer — Design Doc

**Status:** Implemented (infra + DDL)
**Owner:** Data layer track
**Last updated:** 2026-09-05

## 1. Summary

PharmaSentinel is a governed, four-tier text-to-SQL platform that lets an
analyst ask natural-language questions spanning FDA adverse event reports
and clinical trial registrations, and get back SQL-grounded answers rather
than free-text guesses. This document describes the data layer underneath
that platform: where the data comes from, why it is organized into four
Postgres schemas instead of one, and the specific domain constraints —
MedDRA licensing, the absence of a CTCAE severity scale in FAERS, and known
data-quality gaps in both source systems — that shaped the design. It does
not cover the ETL implementation, the text-to-SQL prompt/grounding strategy,
or the Tier 4 fallback mechanism itself; those are owned by other tracks
and are referenced here only where they touch the schema contract.

## 2. Data sources

### 2.1 OpenFDA FAERS (drug adverse event reports)

FAERS — the FDA Adverse Event Reporting System — is FDA's post-market
surveillance database of adverse event and medication error reports
submitted by manufacturers, healthcare professionals, and consumers. We
ingest it through the OpenFDA drug/event API and its corresponding bulk
JSON downloads, rather than the older ASCII/SGML quarterly extract files
that FDA also publishes, because OpenFDA already normalizes the record
structure into a stable per-report JSON document (one `safetyreportid` with
nested `patient`, `drug[]`, and `reaction[]` structures) and is the format
the ETL track ingests from. Our raw tables (`faers.report`, `faers.patient`,
`faers.drug`, `faers.reaction`) mirror that nesting directly: one parent row
per report, three child tables for the one-to-many pieces.

It is important to be explicit about what FAERS is and is not. It is a
**spontaneous, voluntary reporting system**: report volume reflects
reporting behavior (product age, media attention, litigation activity) at
least as much as it reflects true adverse event incidence. A high report
count for a drug/reaction pair is a *signal to investigate*, not a
prevalence estimate, and nothing in this schema should be read as implying
otherwise. This caveat belongs in any user-facing surface built on top of
`sem.*`, not just in this document.

### 2.2 ClinicalTrials.gov (trial registrations)

Trial data comes from the ClinicalTrials.gov API v2 `/studies` endpoint.
We model the subset of the protocol section that matters for this
platform's questions: study identity and status (`ct.study`), studied
conditions (`ct.condition`), registered interventions (`ct.intervention`),
and prespecified outcome measures (`ct.outcome_measure`). We deliberately do
not model the *results* section of the API (reported outcome data, adverse
event tables sponsors submit post-completion) in this pass — that is a
substantially larger and messier resource, and the platform's initial
cross-dataset questions ("which trials study X") only need the protocol
section. If a future iteration needs sponsor-reported trial AE data, it
should land as new raw tables under `ct.*` and new `sem.*` views, following
the same pattern established here — not by overloading the existing
tables.

`nct_id` (e.g. `NCT01234567`) is used as the primary key throughout rather
than a synthetic surrogate key, because it is the stable natural identifier
ClinicalTrials.gov itself assigns and guarantees uniqueness for; introducing
a surrogate would only add an indirection with no benefit.

## 3. Why raw / ont / sem, not one schema

The database is split into four schemas — `faers`, `ct`, `ont`, `sem` — that
map onto the platform's tier model as follows:

| Schema  | Tier   | Role                                                                 |
|---------|--------|------------------------------------------------------------------------|
| `faers` | (raw)  | Ingestion substrate: OpenFDA data loaded close to verbatim            |
| `ct`    | (raw)  | Ingestion substrate: ClinicalTrials.gov data loaded close to verbatim  |
| `ont`   | 1      | Ontology/governance: field catalog, curated term/class/synonym lookups |
| `sem`   | 2      | Curated, denormalized, governed views — the Tier 3 grounding surface   |

This split exists because raw ingestion and LLM-facing grounding have
opposite stability requirements. Raw tables need to absorb whatever shape
OpenFDA or ClinicalTrials.gov hand us, including future schema evolution on
their end, without that churn propagating into every prompt or generated
query downstream. The semantic layer, conversely, needs to be small,
documented, and stable enough that (a) an LLM's generated SQL against it is
predictable and reviewable, and (b) a human reviewer can read every view in
`sem.*` in one sitting and reason about the full space of what Tier 3 is
capable of returning. Collapsing these into one schema would force a choice
between a grounding surface that churns with every upstream field addition,
or a raw layer contorted to look LLM-friendly at ingestion time — both of
which are worse than keeping the concerns separate.

The `ont` schema sits in between as shared infrastructure: it is metadata
*about* the data (what does this column mean, what body system does this
reaction term belong to, what is the canonical ingredient for this brand
name) rather than the data itself, and both the semantic views and,
eventually, Tier 3/4 query logic need to read it. Keeping it as its own
schema — rather than, say, folding the lookup tables into `sem` — reflects
that it is conceptually a different kind of object: governance/reference
data with its own curation lifecycle, not a join of transactional records.

This split is also what makes the platform's access control model
enforceable rather than aspirational. `db/ddl/005_roles.sql` grants the
`app_runtime` role (Tier 3 / normal application access) `SELECT` on `sem.*`
and `ont.*` only, with no access whatsoever to `faers.*`/`ct.*`. A second
role, `app_runtime_tier4`, additionally grants the raw schemas and is meant
only for the documented Tier 4 fallback path. If Tier 3 ever generates
`SELECT * FROM faers.report` — whether from a bug or an adversarial
prompt — that query fails at the database connection, not merely at an
application-layer check that could be bypassed or forgotten. Because the
two roles are distinct rather than one role with conditionally wider scope,
which role a given connection used is itself an audit signal: any query
that ran as `app_runtime_tier4` is self-evidently a fallback-path query.

## 4. The MedDRA licensing constraint

FAERS reaction terms (`faers.reaction.reactionmeddrapt`) are MedDRA
(Medical Dictionary for Regulatory Activities) Preferred Terms. The full
MedDRA terminology — its System Organ Class → High Level Group Term → High
Level Term → Preferred Term → Lowest Level Term hierarchy — is proprietary,
licensed through the MedDRA Maintenance and Support Services Organization
(MSSO), and is not something this project has a subscription to or is
permitted to redistribute.

We handle this by storing reaction terms as plain free-text strings
(exactly as OpenFDA reports them) and layering a small, explicitly
**hand-curated, illustrative** lookup table, `ont.meddra_pt`, on top: a
`pt_term → body_system` bucket mapping covering roughly cardiac, hepatic,
oncology-relevant, and a handful of other commonly discussed adverse event
areas (see `db/seed/meddra_pt_curated.csv` — about 60 terms across eight
body-system buckets). This is explicitly *not* the MedDRA hierarchy: it has
no SOC/HLGT/HLT/LLT structure, no claim of completeness, and no clinical
authority. It exists solely so the semantic views and demo queries have a
grouping mechanism to work with. The table carries a prominent comment in
`db/ddl/003_ontology.sql` to this effect, and any consumer-facing surface
built on `body_system` should describe it as "an illustrative grouping,"
never as "the MedDRA System Organ Class." If this project later obtains a
MedDRA subscription, `ont.meddra_pt` is designed to be a drop-in
replacement target: swap or extend it with the licensed SOC mapping loaded
from the MedDRA ASCII distribution, and every downstream view that joins on
`pt_term` continues to work unchanged.

## 5. FAERS has no CTCAE grade — the severity proxy problem

Clinical trial adverse event reporting conventionally uses CTCAE (Common
Terminology Criteria for Adverse Events), a numeric 1–5 grading scale for
event severity. FAERS uses a completely different, non-numeric model: a set
of independent regulatory "seriousness" flags per report — `serious`,
`seriousnessdeath`, `seriousnesshospitalization`,
`seriousnesslifethreatening`, `seriousnessdisabling` — indicating which
FDA-defined criteria the report met. **There is no crosswalk between these
two scales.** A report flagged `seriousnesshospitalization=true` is not
"Grade 3," and no computation on these booleans produces a CTCAE grade.

Because a central goal of this platform is answering cross-dataset
questions like "Phase 3 oncology trials evaluating kinase inhibitors with
cardiac AEs" — which requires *some* notion of AE severity on the FAERS
side to be useful — we made a deliberate, documented choice: the FAERS
seriousness flags are used throughout `sem.*` as an explicit **proxy** for
severity, never silently relabeled as a grade. This is stated in three
places so it cannot be missed by whoever builds on top of this layer next:
the column comments in `db/ddl/001_raw_faers.sql`, the view comment on
`sem.faers_case_summary`, and a dedicated warning block in the header of
`sem.drug_trial_ae_link` in `db/ddl/004_semantic_views.sql`. Any Tier 3
prompt template or Tier 4 fallback response that surfaces these fields
should describe them as "FDA seriousness criteria" in user-facing text, not
as "AE grade" or "severity score."

`sem.drug_trial_ae_link` is the view where this matters most operationally:
it links a trial's registered interventions to FAERS cases sharing a
canonical active ingredient (via `ont.drug_synonym`, see §6), and exposes
the FAERS seriousness flags and aggregated reaction body systems alongside
trial phase, condition, and intervention. This lets a query filter "cardiac
AEs" via `body_system` and "seriousness" via the FDA flags in one join,
without ever asserting that this tells you anything about CTCAE grade
distribution in the underlying trial population — that data, if it exists
at all, would come from the trial's own results reporting, not FAERS.

## 6. Known data-quality gaps

Two gaps are worth calling out explicitly because they affect how
confidently `sem.*` results can be interpreted, and because they receive
different treatment in this pass.

### 6.1 Duplicate and nullified FAERS reports

FAERS is well documented (including by FDA itself) to contain duplicate
case reports — the same underlying adverse event submitted more than once,
sometimes by different parties (e.g. both the reporting physician and the
manufacturer), each producing a distinct `safetyreportid`. FDA's quarterly
extracts include a deletion/nullification file for reports later withdrawn
or superseded, which OpenFDA's API does not always surface transparently in
the same way. Neither the raw tables nor the semantic views in this pass
perform deduplication or exclude nullified reports; `faers.report` contains
exactly what OpenFDA returned. This is a conscious scoping decision, not an
oversight: reliable FAERS deduplication is a nontrivial project of its own
(heuristics typically combine `companynumb`, reported dates, drug/reaction
overlap, and demographic similarity, and FDA's own guidance is that no
fully reliable automated method exists). We are flagging it here as a known
gap rather than shipping a half-reliable heuristic that could create false
confidence. Any aggregate count derived from `sem.faers_case_summary` or
`sem.faers_drug_reaction` (e.g. "how many reports mention X") should be
presented as "reports," not "unique patients" or "unique events," and this
caveat should propagate into Tier 3's answer templates. A future pass could
add a `sem`-layer deduplication view once a heuristic is agreed on, without
changing the raw tables.

### 6.2 Drug name variants

Both source systems report drug names as free text: FAERS reporters and
ClinicalTrials.gov sponsors each independently write brand names, generic
names, sponsor code names, and — for FAERS in particular, since much of it
is consumer- and clinician-submitted — misspellings. The same active
ingredient can appear under many surface forms across, and even within, the
two datasets. Left unaddressed, this would silently break the exact-match
joins the cross-dataset view depends on: a trial registered under a code
name would never link to FAERS cases reported under the eventual brand
name for the same substance.

We address this with `ont.drug_synonym`: a `surface_form → canonical_ingredient`
lookup table, keyed on the surface form (so each spelling maps to exactly
one canonical ingredient, while a canonical ingredient can naturally have
many surface forms pointing to it). It is read from two places: the ETL
track uses it at load time to populate `faers.drug.active_ingredient`
from the verbatim `drugname`, and `sem.drug_trial_ae_link` uses it at query
time to normalize both `ct.intervention.intervention_name` and FAERS
primary-suspect ingredients onto the same canonical value before joining.
Where a surface form has no synonym entry yet, the view falls back to a
case-insensitive exact match on the raw name rather than dropping the row —
a deliberately soft fallback that keeps unmapped-but-identically-spelled
names working, while making no claim that lowercase string equality is a
generally reliable normalization. `ont.drug_synonym` is expected to grow
over time as the ETL track and Tier 4 fallback path encounter new surface
forms; it ships in this pass with schema and join wiring only, seeded via
whatever entries the ETL track adds, not a comprehensive brand/generic
dictionary — building that dictionary out is ongoing curation work, not a
one-time DDL task.

## 7. Non-goals of this pass

For clarity, this pass covers infrastructure and DDL only:

- No ETL/ingestion code (owned by another track) — the raw table shapes in
  §2 are the contract that track loads into.
- No text-to-SQL generation or prompt grounding logic (Tier 3, owned by
  another track) — `sem.*` is the contract it is grounded on.
- No Tier 4 fallback implementation (owned by another track) — this pass
  only provisions the `app_runtime_tier4` role it will need.
- No MedDRA hierarchy, no CTCAE crosswalk, no FAERS deduplication — each
  called out above as a deliberately deferred or out-of-scope concern, not
  an accidental gap.
