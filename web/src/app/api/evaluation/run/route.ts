import { NextResponse } from "next/server";
import { goldCases } from "../../../../../scripts/eval/goldCases";
import { runGoldCases, type GoldCaseSummary } from "../../../../../scripts/eval/runner";

export interface EvaluationRunResponseBody extends GoldCaseSummary {
  totalCases: number;
}

/**
 * GET /api/evaluation/run
 *
 * Runs every gold case in `scripts/eval/goldCases.ts` (via
 * `runGoldCases` from `scripts/eval/runner.ts`) and returns the summary as
 * JSON: overall pass/fail counts, a breakdown by category and by split,
 * and per-case timing/detail.
 *
 * This does NOT enforce the promotion gate (`promotionGate` from
 * `runner.ts`) — that's a hard CI gate meant to throw/exit non-zero
 * (`scripts/eval-gate.ts`), not something a dashboard GET request should
 * ever throw a 500 over. The dashboard instead surfaces test-split
 * failures as a status pill so a human can see the same signal without an
 * unhandled-exception response.
 *
 * Honest-empty-state note: with `goldCases` at its current size (some
 * categories still pending real FAERS/CT.gov reference data — see the
 * doc comment at the top of `goldCases.ts`), this can legitimately return
 * a summary with `totalCases: 0` if the array were ever empty; the caller
 * (the Evaluation page) is expected to render that cleanly rather than
 * treat it as an error.
 */
export async function GET(): Promise<Response> {
  try {
    const summary = await runGoldCases(goldCases);
    const response: EvaluationRunResponseBody = {
      ...summary,
      totalCases: goldCases.length,
    };
    return NextResponse.json(response);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to run gold cases: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
