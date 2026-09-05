"use client";

import { useCallback, useEffect, useState } from "react";

interface GoldCaseRunResult {
  id: string;
  category: string;
  split: "train" | "test";
  pass: boolean;
  detail: string;
  durationMs: number;
}

interface EvaluationRunResponse {
  totalCases: number;
  totalPass: number;
  totalFail: number;
  results: GoldCaseRunResult[];
  byCategory: Record<string, { pass: number; fail: number }>;
  bySplit: Record<"train" | "test", { pass: number; fail: number }>;
  error?: string;
}

type StatusPill = "green" | "amber" | "red";

function passRate(pass: number, fail: number): number {
  const total = pass + fail;
  if (total === 0) return 0;
  return pass / total;
}

function statusFor(pass: number, fail: number): StatusPill {
  if (pass + fail === 0) return "amber";
  const rate = passRate(pass, fail);
  if (rate === 1) return "green";
  if (rate >= 0.5) return "amber";
  return "red";
}

function StatusDot({ status }: { status: StatusPill }) {
  return <span className={`evaluation-pill evaluation-pill--${status}`} aria-label={status} />;
}

/**
 * Live Evaluation Dashboard.
 *
 * Fetches `/api/evaluation/run` (which runs `scripts/eval/goldCases.ts`
 * via `runGoldCases`/`promotionGate` from `scripts/eval/runner.ts`) and
 * renders a summary table grouped by category and by split, plus a
 * "Run now" button to re-trigger it.
 *
 * Handles the honest current state: if `goldCases` is empty or mostly
 * stubbed, this renders "0 cases" cleanly rather than crashing — see the
 * category-coverage note in `scripts/eval/goldCases.ts`'s header comment
 * for which categories still need real FAERS/CT.gov reference data before
 * they can be added.
 */
export default function EvaluationTab() {
  const [data, setData] = useState<EvaluationRunResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runNow = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/evaluation/run");
      const json = (await response.json()) as EvaluationRunResponse;
      if (!response.ok) {
        setError(json.error ?? `Request failed with status ${response.status}.`);
        setData(null);
      } else {
        setData(json);
      }
    } catch (err) {
      setError((err as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runNow();
  }, [runNow]);

  const categoryRows = data ? Object.entries(data.byCategory) : [];
  const splitRows = data
    ? (Object.entries(data.bySplit) as Array<["train" | "test", { pass: number; fail: number }]>)
    : [];

  const testGateStatus =
    data && data.bySplit.test.pass + data.bySplit.test.fail > 0
      ? data.bySplit.test.fail === 0
        ? "green"
        : "red"
      : "amber";

  return (
    <div className="evaluation-root">
      <h2>Evaluation</h2>
      <p>
        Runs and results from the gold-case eval suite (
        <code>scripts/eval/goldCases.ts</code>) — pass rate by category and
        split, and the test-split promotion gate.
      </p>

      <button className="evaluation-run-button" onClick={() => void runNow()} disabled={loading}>
        {loading ? "Running…" : "Run now"}
      </button>

      {error && <p className="evaluation-error">{error}</p>}

      {data && (
        <div className="evaluation-summary">
          <p className="evaluation-total-line">
            {data.totalCases === 0
              ? "0 cases — the gold-case suite has no cases yet for this environment."
              : `${data.totalCases} case${data.totalCases === 1 ? "" : "s"}: ${data.totalPass} passed, ${data.totalFail} failed.`}
          </p>

          <p className="evaluation-gate-line">
            <StatusDot status={testGateStatus} /> Promotion gate (test split):{" "}
            {data.bySplit.test.pass + data.bySplit.test.fail === 0
              ? "no test-split cases yet"
              : data.bySplit.test.fail === 0
                ? "PASS"
                : `FAIL (${data.bySplit.test.fail} test-split case${data.bySplit.test.fail === 1 ? "" : "s"} failing)`}
          </p>

          <h3>By category</h3>
          {categoryRows.length === 0 ? (
            <p className="evaluation-empty">No categories yet.</p>
          ) : (
            <div className="evaluation-table-wrap">
              <table className="evaluation-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Pass</th>
                    <th>Fail</th>
                    <th>Pass rate</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {categoryRows.map(([category, counts]) => {
                    const status = statusFor(counts.pass, counts.fail);
                    return (
                      <tr key={category}>
                        <td>{category}</td>
                        <td>{counts.pass}</td>
                        <td>{counts.fail}</td>
                        <td>{Math.round(passRate(counts.pass, counts.fail) * 100)}%</td>
                        <td>
                          <StatusDot status={status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <h3>By split</h3>
          {splitRows.length === 0 ? (
            <p className="evaluation-empty">No splits yet.</p>
          ) : (
            <div className="evaluation-table-wrap">
              <table className="evaluation-table">
                <thead>
                  <tr>
                    <th>Split</th>
                    <th>Pass</th>
                    <th>Fail</th>
                    <th>Pass rate</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {splitRows.map(([split, counts]) => {
                    const status = statusFor(counts.pass, counts.fail);
                    return (
                      <tr key={split}>
                        <td>{split}</td>
                        <td>{counts.pass}</td>
                        <td>{counts.fail}</td>
                        <td>{Math.round(passRate(counts.pass, counts.fail) * 100)}%</td>
                        <td>
                          <StatusDot status={status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <h3>Case details</h3>
          {data.results.length === 0 ? (
            <p className="evaluation-empty">No cases ran.</p>
          ) : (
            <div className="evaluation-table-wrap">
              <table className="evaluation-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Category</th>
                    <th>Split</th>
                    <th>Result</th>
                    <th>Duration (ms)</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((result) => (
                    <tr key={result.id}>
                      <td>{result.id}</td>
                      <td>{result.category}</td>
                      <td>{result.split}</td>
                      <td>
                        <StatusDot status={result.pass ? "green" : "red"} /> {result.pass ? "pass" : "fail"}
                      </td>
                      <td>{result.durationMs}</td>
                      <td className="evaluation-detail-cell">{result.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
