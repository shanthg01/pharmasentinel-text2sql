export type GuardrailVerdict = "allow" | "reject" | "clarify";

export interface GuardrailResult {
  verdict: GuardrailVerdict;
  category?: string;
  message?: string;
}

// Deliberately simple, hardcoded patterns for the cheap Layer 1 pass — the
// LLM classifier (classify.ts) is the real backstop for anything subtler.
const PHI_PATTERNS: RegExp[] = [
  /\bwho\s+is\s+(the\s+)?patient\b/i,
  /\bidentify\s+(the\s+)?patient\b/i,
  /\bpatient'?s?\s+(name|address|ssn|social\s+security|date\s+of\s+birth)\b/i,
  /\b(name|identity)\s+of\s+(the\s+)?patient\b/i,
];

const MIN_WORD_COUNT = 3;

/**
 * Layer 1 deterministic pre-checks — no LLM call, near-zero latency/cost.
 *
 * Returns a verdict when it can decide outright (empty input, an obvious
 * PHI request, an obviously underspecified question); returns `null` to
 * fall through to Layer 2 (`classify.ts`) for anything it can't confidently
 * decide on its own.
 */
export function runPreChecks(question: string): GuardrailResult | null {
  const trimmed = question.trim();

  if (trimmed.length === 0) {
    return {
      verdict: "reject",
      category: "empty_input",
      message: "Please enter a question.",
    };
  }

  for (const pattern of PHI_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        verdict: "reject",
        category: "phi_request",
        message:
          "This system reports on de-identified, aggregate data and cannot identify individual patients.",
      };
    }
  }

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORD_COUNT) {
    return {
      verdict: "clarify",
      category: "underspecified",
      message:
        "Could you say more about what drug, adverse event, or metric you're interested in?",
    };
  }

  // No outright verdict from deterministic checks — let Layer 2 decide.
  return null;
}
