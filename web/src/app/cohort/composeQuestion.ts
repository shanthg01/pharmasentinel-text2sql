// Cohort-form types and the form->question composer, split out of
// page.tsx: Next.js's generated route types (`.next/types/app/.../page.ts`)
// restrict page.tsx to its known special exports (default, metadata,
// config, etc.), so any other named export from a page.tsx file fails
// `tsc`'s typegen check. Shared/testable logic like this belongs in its
// own module instead.

export const TRIAL_PHASES = [
  "Phase 1",
  "Phase 2",
  "Phase 3",
  "Phase 4",
  "Not Applicable",
] as const;

// Matches `ont.meddra_pt`'s body_system buckets.
export const BODY_SYSTEMS = [
  "Cardiac",
  "Hepatic",
  "Renal",
  "Haematological",
  "Respiratory",
  "Gastrointestinal",
  "Dermatological",
  "Neurological",
] as const;

export type TrialPhase = (typeof TRIAL_PHASES)[number];
export type BodySystem = (typeof BODY_SYSTEMS)[number] | "Any";

export interface CohortForm {
  drug: string;
  condition: string;
  phases: TrialPhase[];
  bodySystem: BodySystem;
  seriousOnly: boolean;
}

export const INITIAL_COHORT_FORM: CohortForm = {
  drug: "",
  condition: "",
  phases: [],
  bodySystem: "Any",
  seriousOnly: true,
};

/**
 * Composes the structured form into a single natural-language question,
 * e.g. "Phase 3 trials for lung cancer evaluating pembrolizumab with
 * Cardiac adverse events, serious cases only."
 */
export function composeQuestion(form: CohortForm): string {
  const phaseLabel = form.phases.length > 0 ? form.phases.join("/") : "All-phase";
  const segments = [`${phaseLabel} trials`];

  if (form.condition.trim()) {
    segments.push(`for ${form.condition.trim()}`);
  }
  if (form.drug.trim()) {
    segments.push(`evaluating ${form.drug.trim()}`);
  }

  let question = segments.join(" ");
  if (form.bodySystem !== "Any") {
    question += ` with ${form.bodySystem} adverse events`;
  }
  question += form.seriousOnly ? ", serious cases only." : ", any seriousness.";

  return question;
}
