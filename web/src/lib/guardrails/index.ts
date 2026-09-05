import { runPreChecks, type GuardrailResult } from "./preChecks";
import { classifyQuestion } from "./classify";

export type { GuardrailResult, GuardrailVerdict } from "./preChecks";
export {
  CLAUDE_MODEL,
  GUARDRAIL_CATEGORIES,
  REJECTION_MESSAGES,
  type GuardrailCategory,
} from "./classify";
export { runPreChecks } from "./preChecks";
export { classifyQuestion } from "./classify";

/**
 * Combined guardrail pipeline: deterministic Layer 1 pre-checks first,
 * falling through to the Layer 2 LLM classifier only when Layer 1 has no
 * outright verdict.
 */
export async function runGuardrails(question: string): Promise<GuardrailResult> {
  const preCheckResult = runPreChecks(question);
  if (preCheckResult) {
    return preCheckResult;
  }
  return classifyQuestion(question);
}
