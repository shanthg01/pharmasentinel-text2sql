import type { GoldCase } from "./goldCases";

export interface GoldCaseRunResult {
  id: string;
  category: string;
  split: GoldCase["split"];
  pass: boolean;
  detail: string;
  durationMs: number;
}

export interface GoldCaseSummary {
  results: GoldCaseRunResult[];
  totalPass: number;
  totalFail: number;
  byCategory: Record<string, { pass: number; fail: number }>;
  bySplit: Record<GoldCase["split"], { pass: number; fail: number }>;
}

/**
 * Run every gold case's `assert()`, collecting pass/fail + timing, and
 * return a summary grouped by category and by split.
 */
export async function runGoldCases(cases: GoldCase[]): Promise<GoldCaseSummary> {
  const results: GoldCaseRunResult[] = [];

  for (const goldCase of cases) {
    const start = Date.now();
    let pass = false;
    let detail = "";
    try {
      const outcome = await goldCase.assert();
      pass = outcome.pass;
      detail = outcome.detail;
    } catch (err) {
      pass = false;
      detail = `Threw: ${(err as Error).message}`;
    }
    results.push({
      id: goldCase.id,
      category: goldCase.category,
      split: goldCase.split,
      pass,
      detail,
      durationMs: Date.now() - start,
    });
  }

  const byCategory: GoldCaseSummary["byCategory"] = {};
  const bySplit: GoldCaseSummary["bySplit"] = {
    train: { pass: 0, fail: 0 },
    test: { pass: 0, fail: 0 },
  };

  let totalPass = 0;
  let totalFail = 0;

  for (const result of results) {
    const categoryBucket = byCategory[result.category] ?? { pass: 0, fail: 0 };
    byCategory[result.category] = categoryBucket;

    if (result.pass) {
      categoryBucket.pass += 1;
      bySplit[result.split].pass += 1;
      totalPass += 1;
    } else {
      categoryBucket.fail += 1;
      bySplit[result.split].fail += 1;
      totalFail += 1;
    }
  }

  return { results, totalPass, totalFail, byCategory, bySplit };
}

/**
 * Hard promotion gate: throws if any `split: "test"` case failed. Train-
 * split failures are informational only and do not block promotion.
 *
 * This is the gate other tooling (e.g. scripts/eval-gate.ts) calls before
 * allowing a change to be promoted.
 */
export function promotionGate(summary: GoldCaseSummary): void {
  const failedTestCases = summary.results.filter(
    (result) => result.split === "test" && !result.pass,
  );
  if (failedTestCases.length > 0) {
    const ids = failedTestCases.map((result) => result.id).join(", ");
    throw new Error(
      `Promotion gate failed: ${failedTestCases.length} test-split case(s) failed: ${ids}`,
    );
  }
}
