// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const postChatMock = vi.fn();

vi.mock("./apiClient", () => ({
  postChat: (...args: unknown[]) => postChatMock(...args),
  newSessionId: () => "test-session-id",
}));

const { default: CohortPage } = await import("./page");

describe("CohortPage", () => {
  beforeEach(() => {
    postChatMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the form with no result yet, and the seriousness caveat", () => {
    render(<CohortPage />);

    expect(screen.getByLabelText(/drug \/ drug class/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/condition \/ indication/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/adverse event body system/i)).toBeInTheDocument();
    expect(screen.getByText(/build cohort/i)).toBeInTheDocument();

    // No result section until a submit happens.
    expect(screen.queryByText(/composed question:/i)).not.toBeInTheDocument();

    // The documented FAERS-severity-proxy caveat is visible near the toggle.
    expect(
      screen.getByText(/FAERS has no real CTCAE grade field/i),
    ).toBeInTheDocument();
  });

  it("composes the structured fields into a question and sends it on submit", async () => {
    postChatMock.mockResolvedValue({ kind: "tier3", sql: "SELECT 1", rows: [] });
    render(<CohortPage />);

    fireEvent.change(screen.getByLabelText(/drug \/ drug class/i), {
      target: { value: "pembrolizumab" },
    });
    fireEvent.change(screen.getByLabelText(/condition \/ indication/i), {
      target: { value: "lung cancer" },
    });
    fireEvent.click(screen.getByLabelText("Phase 3"));
    fireEvent.change(screen.getByLabelText(/adverse event body system/i), {
      target: { value: "Cardiac" },
    });
    // Seriousness defaults to "Serious only" already; leave it as-is.

    fireEvent.click(screen.getByRole("button", { name: /build cohort/i }));

    await waitFor(() => expect(postChatMock).toHaveBeenCalledTimes(1));
    expect(postChatMock).toHaveBeenCalledWith(
      "Phase 3 trials for lung cancer evaluating pembrolizumab with Cardiac adverse events, serious cases only.",
      "test-session-id",
    );

    expect(await screen.findByText(/composed question:/i)).toBeInTheDocument();
  });

  it("renders a successful response's SQL and rows as a cohort table", async () => {
    postChatMock.mockResolvedValue({
      kind: "tier4",
      sql: "SELECT trial_id, phase FROM ct.trials",
      rows: [{ trial_id: "NCT001", phase: "Phase 3" }],
    });
    render(<CohortPage />);

    fireEvent.click(screen.getByRole("button", { name: /build cohort/i }));

    await waitFor(() =>
      expect(screen.getByText(/SELECT trial_id, phase FROM ct.trials/)).toBeInTheDocument(),
    );
    expect(screen.getByText("NCT001")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy as csv/i })).toBeInTheDocument();
  });

  it("renders a guardrail rejection distinctly from a normal answer", async () => {
    postChatMock.mockResolvedValue({
      kind: "reject",
      category: "off_topic",
      message: "I can only answer questions about drug safety data.",
    });
    render(<CohortPage />);

    fireEvent.click(screen.getByRole("button", { name: /build cohort/i }));

    await waitFor(() =>
      expect(
        screen.getByText("I can only answer questions about drug safety data."),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/request declined/i)).toBeInTheDocument();
    expect(document.querySelector("pre.chat-sql")).not.toBeInTheDocument();
    expect(document.querySelector('[data-kind="reject"]')).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy as csv/i })).not.toBeInTheDocument();
  });
});
