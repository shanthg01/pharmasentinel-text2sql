"use client";

import { useId, useState, type FormEvent } from "react";
import { postChat, newSessionId, type ChatApiResponse } from "./apiClient";
import { ResultTable, formatCell } from "../chat/ResultTable";
import {
  TRIAL_PHASES,
  BODY_SYSTEMS,
  INITIAL_COHORT_FORM,
  composeQuestion,
  type BodySystem,
  type TrialPhase,
} from "./composeQuestion";

type SubmitState =
  | { status: "idle" }
  | { status: "loading"; question: string }
  | { status: "result"; question: string; response: ChatApiResponse }
  | { status: "error"; question: string; message: string };

function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) {
    return "";
  }
  const columns = Object.keys(rows[0]);
  const escape = (value: unknown): string => {
    const text = formatCell(value);
    if (/[",\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escape(row[column])).join(","));
  }
  return lines.join("\n");
}

export default function CohortPage() {
  const [form, setForm] = useState(INITIAL_COHORT_FORM);
  const [submit, setSubmit] = useState<SubmitState>({ status: "idle" });
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [sessionId] = useState(() => newSessionId());
  const formId = useId();

  const loading = submit.status === "loading";

  function togglePhase(phase: TrialPhase) {
    setForm((prev) => ({
      ...prev,
      phases: prev.phases.includes(phase)
        ? prev.phases.filter((p) => p !== phase)
        : [...prev.phases, phase],
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) {
      return;
    }

    const question = composeQuestion(form);
    setCopyStatus("idle");
    setSubmit({ status: "loading", question });

    try {
      const response = await postChat(question, sessionId);
      setSubmit({ status: "result", question, response });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setSubmit({ status: "error", question, message });
    }
  }

  async function handleCopyCsv(rows: Array<Record<string, unknown>>) {
    const csv = rowsToCsv(rows);
    try {
      await navigator.clipboard.writeText(csv);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <div className="cohort-page">
      <h2>Clinical Cohort Builder</h2>
      <p>
        Build a cohort question from structured filters instead of free text.
        Submitting composes these fields into a single question and sends it
        through the same governed pipeline as the Chat tab.
      </p>

      <form className="cohort-form" onSubmit={handleSubmit}>
        <div className="cohort-field">
          <label htmlFor={`${formId}-drug`}>Drug / drug class</label>
          <input
            id={`${formId}-drug`}
            type="text"
            value={form.drug}
            onChange={(event) => setForm((prev) => ({ ...prev, drug: event.target.value }))}
            placeholder="e.g. pembrolizumab, or SGLT2 inhibitors"
          />
        </div>

        <div className="cohort-field">
          <label htmlFor={`${formId}-condition`}>Condition / indication</label>
          <input
            id={`${formId}-condition`}
            type="text"
            value={form.condition}
            onChange={(event) => setForm((prev) => ({ ...prev, condition: event.target.value }))}
            placeholder="e.g. non-small cell lung cancer"
          />
        </div>

        <fieldset className="cohort-field cohort-fieldset">
          <legend>Trial phase</legend>
          <div className="cohort-checkbox-group">
            {TRIAL_PHASES.map((phase) => (
              <label key={phase} className="cohort-checkbox">
                <input
                  type="checkbox"
                  checked={form.phases.includes(phase)}
                  onChange={() => togglePhase(phase)}
                />
                {phase}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="cohort-field">
          <label htmlFor={`${formId}-body-system`}>Adverse event body system</label>
          <select
            id={`${formId}-body-system`}
            value={form.bodySystem}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, bodySystem: event.target.value as BodySystem }))
            }
          >
            <option value="Any">Any</option>
            {BODY_SYSTEMS.map((system) => (
              <option key={system} value={system}>
                {system}
              </option>
            ))}
          </select>
        </div>

        <div className="cohort-field">
          <span className="cohort-toggle-label">Seriousness</span>
          <div className="cohort-toggle-group" role="radiogroup" aria-label="Seriousness">
            <label className="cohort-radio">
              <input
                type="radio"
                name={`${formId}-seriousness`}
                checked={form.seriousOnly}
                onChange={() => setForm((prev) => ({ ...prev, seriousOnly: true }))}
              />
              Serious only
            </label>
            <label className="cohort-radio">
              <input
                type="radio"
                name={`${formId}-seriousness`}
                checked={!form.seriousOnly}
                onChange={() => setForm((prev) => ({ ...prev, seriousOnly: false }))}
              />
              Any
            </label>
          </div>
          <p className="cohort-caveat">
            FAERS has no real CTCAE grade field. &ldquo;Seriousness&rdquo; flags
            (hospitalization, life-threatening, death, disability) are used here as a
            documented proxy for severity, not a real clinical grade.
          </p>
        </div>

        <button className="cohort-submit" type="submit" disabled={loading}>
          {loading ? "Building cohort…" : "Build cohort"}
        </button>
      </form>

      {submit.status !== "idle" && (
        <div className="cohort-result">
          <div className="cohort-question">
            <span className="cohort-question-label">Composed question:</span> {submit.question}
          </div>

          {submit.status === "loading" && <p className="chat-empty">Running query…</p>}

          {submit.status === "error" && (
            <div className="chat-bubble chat-bubble--assistant chat-bubble--error" role="alert">
              <div className="chat-bubble-label">Error</div>
              <div>{submit.message}</div>
            </div>
          )}

          {submit.status === "result" && (
            <CohortResponseView response={submit.response} onCopyCsv={handleCopyCsv} />
          )}

          {copyStatus === "copied" && <p className="cohort-copy-note">Copied CSV to clipboard.</p>}
          {copyStatus === "failed" && (
            <p className="cohort-copy-note cohort-copy-note--error">
              Couldn&apos;t copy to clipboard in this browser.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CohortResponseView({
  response,
  onCopyCsv,
}: {
  response: ChatApiResponse;
  onCopyCsv: (rows: Array<Record<string, unknown>>) => void;
}) {
  if (response.kind === "reject" || response.kind === "clarify") {
    return (
      <div
        className="chat-bubble chat-bubble--assistant chat-bubble--guardrail"
        data-kind={response.kind}
      >
        <div className="chat-bubble-label">
          {response.kind === "reject" ? "Request declined" : "Clarification needed"}
        </div>
        <div>{response.message ?? response.question}</div>
      </div>
    );
  }

  if (response.kind === "no_answer") {
    return (
      <div className="chat-bubble chat-bubble--assistant chat-bubble--guardrail" data-kind="no_answer">
        <div className="chat-bubble-label">No answer available</div>
        <div>{response.message ?? "I couldn't find a way to answer that from the available data."}</div>
      </div>
    );
  }

  const rows = response.rows ?? [];

  return (
    <div className="chat-bubble chat-bubble--assistant" data-kind={response.kind}>
      <div className="chat-bubble-label">Cohort &middot; {response.kind}</div>
      {response.sql && (
        <pre className="chat-sql">
          <code>{response.sql}</code>
        </pre>
      )}
      <ResultTable rows={rows} />
      {rows.length > 0 && (
        <button
          type="button"
          className="cohort-copy-button"
          onClick={() => onCopyCsv(rows)}
        >
          Copy as CSV
        </button>
      )}
    </div>
  );
}
