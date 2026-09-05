// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const postChatMock = vi.fn();

vi.mock("./apiClient", () => ({
  postChat: (...args: unknown[]) => postChatMock(...args),
  newSessionId: () => "test-session-id",
}));

const { default: ChatPage } = await import("./page");

describe("ChatPage", () => {
  beforeEach(() => {
    postChatMock.mockReset();
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
    postChatMock.mockResolvedValue({ kind: "tier3", sql: "SELECT 1", rows: [] });
    render(<ChatPage />);

    const input = screen.getByLabelText(/your question/i);
    fireEvent.change(input, { target: { value: "How many reports for aspirin?" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(postChatMock).toHaveBeenCalledTimes(1));
    expect(postChatMock).toHaveBeenCalledWith(
      "How many reports for aspirin?",
      "test-session-id",
    );

    // The user's own message renders as a bubble.
    expect(screen.getByText("How many reports for aspirin?")).toBeInTheDocument();
    // The input clears after send.
    expect(input).toHaveValue("");
  });

  it("renders a successful response's SQL and rows as a table", async () => {
    postChatMock.mockResolvedValue({
      kind: "tier3",
      sql: "SELECT drug, count(*) FROM faers.reports GROUP BY drug",
      rows: [
        { drug: "aspirin", count: 42 },
        { drug: "metformin", count: 17 },
      ],
    });
    render(<ChatPage />);

    fireEvent.change(screen.getByLabelText(/your question/i), {
      target: { value: "Count reports by drug" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByText(/SELECT drug, count\(\*\)/)).toBeInTheDocument(),
    );

    expect(screen.getByText("aspirin")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("metformin")).toBeInTheDocument();
  });

  it("renders a guardrail rejection distinctly from a normal answer", async () => {
    postChatMock.mockResolvedValue({
      kind: "reject",
      category: "off_topic",
      message: "I can only answer questions about drug safety data.",
    });
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

  it("renders a distinct error state when the request fails", async () => {
    postChatMock.mockRejectedValue(new Error("Network error"));
    render(<ChatPage />);

    fireEvent.change(screen.getByLabelText(/your question/i), {
      target: { value: "Any adverse events for ibuprofen?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Network error")).toBeInTheDocument();
  });
});
