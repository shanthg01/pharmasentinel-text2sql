// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const postChatStreamMock = vi.fn();

vi.mock("./apiClient", () => ({
  postChatStream: (...args: unknown[]) => postChatStreamMock(...args),
  newSessionId: () => "test-session-id",
}));

const { default: ChatPage } = await import("./page");

interface FakeUpdate {
  metadata: Record<string, unknown>;
  textDelta: string;
  textSoFar: string;
}

/** Builds an async generator yielding the given updates -- stands in for
 * `postChatStream`'s real behavior (reading a streamed `Response` body),
 * the same way `route.test.ts` mocks `streamAnswer` with a canned async
 * generator instead of a real Anthropic streaming call. */
async function* fakeUpdates(updates: FakeUpdate[]) {
  for (const update of updates) {
    yield update;
  }
}

describe("ChatPage", () => {
  beforeEach(() => {
    postChatStreamMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the empty state with no messages", () => {
    render(<ChatPage />);
    expect(
      screen.getByText(/no messages yet — ask a question below to get started/i),
    ).toBeInTheDocument();
  });

  it("sends the question and session id to the API on submit", async () => {
    postChatStreamMock.mockReturnValue(
      fakeUpdates([{ metadata: { kind: "tier3", sql: "SELECT 1", rows: [] }, textDelta: "", textSoFar: "" }]),
    );
    render(<ChatPage />);

    const input = screen.getByLabelText(/your question/i);
    fireEvent.change(input, { target: { value: "How many reports for aspirin?" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(postChatStreamMock).toHaveBeenCalledTimes(1));
    expect(postChatStreamMock).toHaveBeenCalledWith(
      "How many reports for aspirin?",
      "test-session-id",
    );

    // The user's own message renders as a bubble.
    expect(screen.getByText("How many reports for aspirin?")).toBeInTheDocument();
    // The input clears after send.
    expect(input).toHaveValue("");
  });

  it("renders a successful response's SQL and rows, and the NL answer growing as it streams in", async () => {
    const rows = [
      { drug: "aspirin", count: 42 },
      { drug: "metformin", count: 17 },
    ];
    const sql = "SELECT drug, count(*) FROM faers.reports GROUP BY drug";

    postChatStreamMock.mockReturnValue(
      fakeUpdates([
        { metadata: { kind: "tier3", sql, rows }, textDelta: "", textSoFar: "" },
        {
          metadata: { kind: "tier3", sql, rows },
          textDelta: "Aspirin has 42 reports",
          textSoFar: "Aspirin has 42 reports",
        },
        {
          metadata: { kind: "tier3", sql, rows },
          textDelta: " and metformin has 17.",
          textSoFar: "Aspirin has 42 reports and metformin has 17.",
        },
      ]),
    );
    render(<ChatPage />);

    fireEvent.change(screen.getByLabelText(/your question/i), {
      target: { value: "Count reports by drug" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    // SQL/rows are present from the very first update.
    await waitFor(() =>
      expect(screen.getByText(/SELECT drug, count\(\*\)/)).toBeInTheDocument(),
    );
    expect(screen.getByText("aspirin")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("metformin")).toBeInTheDocument();

    // The NL answer grows to its final streamed value.
    await waitFor(() =>
      expect(
        screen.getByText("Aspirin has 42 reports and metformin has 17."),
      ).toBeInTheDocument(),
    );
  });

  it("renders a guardrail rejection distinctly from a normal answer, with the streamed message text", async () => {
    postChatStreamMock.mockReturnValue(
      fakeUpdates([
        { metadata: { kind: "reject", category: "off_topic" }, textDelta: "", textSoFar: "" },
        {
          metadata: { kind: "reject", category: "off_topic" },
          textDelta: "I can only answer questions about drug safety data.",
          textSoFar: "I can only answer questions about drug safety data.",
        },
      ]),
    );
    render(<ChatPage />);

    fireEvent.change(screen.getByLabelText(/your question/i), {
      target: { value: "What's the weather today?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(
        screen.getByText("I can only answer questions about drug safety data."),
      ).toBeInTheDocument(),
    );

    expect(screen.getByText(/request declined/i)).toBeInTheDocument();
    // Distinct from a normal tier3/tier4 answer: no SQL block, and the
    // bubble is tagged with the guardrail kind for styling purposes.
    expect(document.querySelector("pre.chat-sql")).not.toBeInTheDocument();
    expect(document.querySelector('[data-kind="reject"]')).toBeInTheDocument();
  });

  it("renders a distinct error state when the streamed request fails", async () => {
    postChatStreamMock.mockImplementation(async function* () {
      throw new Error("Network error");
    });
    render(<ChatPage />);

    fireEvent.change(screen.getByLabelText(/your question/i), {
      target: { value: "Any adverse events for ibuprofen?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Network error")).toBeInTheDocument();
  });
});
