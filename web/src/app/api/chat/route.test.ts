import { beforeEach, describe, expect, it, vi } from "vitest";

const runGuardrailsMock = vi.fn();
const generateTier3SqlMock = vi.fn();
const tier4FallbackMock = vi.fn();
const queryMock = vi.fn();

vi.mock("@/lib/guardrails", () => ({
  runGuardrails: runGuardrailsMock,
}));
vi.mock("@/lib/text2sql/tier3", () => ({
  generateTier3Sql: generateTier3SqlMock,
}));
vi.mock("@/lib/text2sql/tier4", () => ({
  tier4Fallback: tier4FallbackMock,
}));
vi.mock("@/lib/db/client", () => ({
  query: queryMock,
}));

const { POST } = await import("./route");

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat", () => {
  beforeEach(() => {
    runGuardrailsMock.mockReset();
    generateTier3SqlMock.mockReset();
    tier4FallbackMock.mockReset();
    queryMock.mockReset();
  });

  it("returns 400 for a missing question, without touching guardrails/db", async () => {
    const response = await POST(makeRequest({ sessionId: "s1" }));
    expect(response.status).toBe(400);
    expect(runGuardrailsMock).not.toHaveBeenCalled();
  });

  it("short-circuits on a guardrail rejection without calling Tier 3/4 or the DB", async () => {
    runGuardrailsMock.mockResolvedValue({
      verdict: "reject",
      category: "off_topic",
      message: "I can only answer questions about drug safety data.",
    });

    const response = await POST(
      makeRequest({ question: "What's the weather today?", sessionId: "s1" }),
    );
    const json = await response.json();

    expect(json.kind).toBe("reject");
    expect(json.category).toBe("off_topic");
    expect(generateTier3SqlMock).not.toHaveBeenCalled();
    expect(tier4FallbackMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("short-circuits on a guardrail clarify verdict the same way", async () => {
    runGuardrailsMock.mockResolvedValue({
      verdict: "clarify",
      message: "Could you say more?",
    });

    const response = await POST(
      makeRequest({ question: "aspirin", sessionId: "s1" }),
    );
    const json = await response.json();

    expect(json.kind).toBe("clarify");
    expect(generateTier3SqlMock).not.toHaveBeenCalled();
  });
});
