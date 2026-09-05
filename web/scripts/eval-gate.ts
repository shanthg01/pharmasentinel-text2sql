import { goldCases } from "./eval/goldCases";
import { promotionGate, runGoldCases } from "./eval/runner";

/**
 * The hard promotion gate: run every gold case and throw (non-zero exit)
 * if any `split: "test"` case failed. Wire this into CI once
 * `goldCases.ts` is populated — with an empty case list this always
 * trivially passes.
 */
async function main(): Promise<void> {
  const summary = await runGoldCases(goldCases);

  console.log(`Gold cases: ${summary.totalPass} passed, ${summary.totalFail} failed.`);
  console.log("By category:", summary.byCategory);
  console.log("By split:", summary.bySplit);

  promotionGate(summary);
  console.log("Promotion gate: PASS");
}

main().catch((err) => {
  console.error("Promotion gate: FAIL");
  console.error(err);
  process.exitCode = 1;
});
