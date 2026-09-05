import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The hard promotion gate: run every gold case and throw (non-zero exit)
 * if any `split: "test"` case failed. Wire this into CI once
 * `goldCases.ts` is populated — with an empty case list this always
 * trivially passes.
 *
 * Loads env files itself, before importing anything else: unlike
 * `next dev`/`next build` (which load `.env.local` automatically), a bare
 * `tsx` invocation of this script does NOT -- so ANTHROPIC_API_KEY (and any
 * other env var) is simply undefined unless something loads it first.
 * Without this, every Anthropic-dependent gold case silently takes its
 * "no live credentials" skip path, reports a *passing* result either way,
 * and the promotion gate goes green having never actually exercised a live
 * call -- a false sense of coverage discovered by comparing this script's
 * result against a real request through the running dev server for the
 * exact same question and getting a different, real answer.
 *
 * `goldCases`/`runner` are imported dynamically, inside `main()`, so this
 * env-loading runs first -- a static top-level `import` would be hoisted
 * ahead of it regardless of source order (and top-level `await` isn't
 * available in this script's transpile target, so the load can't happen
 * before a static import any other way).
 */
async function main(): Promise<void> {
  // `.env.local` takes precedence over `.env` (mirrors Next.js's own
  // precedence) by loading `.env` first, then `.env.local` overwriting it.
  for (const file of [".env", ".env.local"]) {
    const filePath = path.resolve(process.cwd(), file);
    if (existsSync(filePath)) {
      process.loadEnvFile(filePath);
    }
  }

  const { goldCases } = await import("./eval/goldCases");
  const { promotionGate, runGoldCases } = await import("./eval/runner");

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
