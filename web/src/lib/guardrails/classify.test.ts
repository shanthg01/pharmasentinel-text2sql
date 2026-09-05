import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: createMock },
  })),
}));

const { classifyQuestion, REJECTION_MESSAGES } = await import("./classify");

/** Wraps a tool-call `input` payload the way `messages.create` responds when
 * `tool_choice` forces a single tool call — matches what `classify.ts` reads
 * off `response.content`. */
function toolResponse(input: Record<string, unknown>) {
  return {
    content: [{ type: "tool_use", id: "toolu_1", name: "emit_classification", input }],
  };
}

describe("classifyQuestion", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("returns the model's structured verdict when it allows the question", async () => {
    createMock.mockResolvedValue(toolResponse({ verdict: "allow" }));

    const result = await classifyQuestion("How many events for metformin?");
    expect(result.verdict).toBe("allow");
  });

  it("falls back to the fixed rejection message for a known category", async () => {
    createMock.mockResolvedValue(
      toolResponse({ verdict: "reject", category: "phi_request" }),
    );

    const result = await classifyQuestion("Who is patient X?");
    expect(result.verdict).toBe("reject");
    expect(result.category).toBe("phi_request");
    expect(result.message).toBe(REJECTION_MESSAGES.phi_request);
  });

  it("prefers the model's own message over the fixed fallback when present", async () => {
    createMock.mockResolvedValue(
      toolResponse({
        verdict: "reject",
        category: "off_topic",
        message: "Custom message from the model.",
      }),
    );

    const result = await classifyQuestion("What's the weather?");
    expect(result.message).toBe("Custom message from the model.");
  });

  it("defaults to clarify when the model returns no tool call", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "uh, ok" }] });

    const result = await classifyQuestion("???");
    expect(result.verdict).toBe("clarify");
  });

  it("defaults to clarify when the tool call's input fails schema validation", async () => {
    createMock.mockResolvedValue(toolResponse({ verdict: "not-a-real-verdict" }));

    const result = await classifyQuestion("???");
    expect(result.verdict).toBe("clarify");
  });
});
