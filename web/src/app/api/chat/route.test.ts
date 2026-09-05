import { beforeEach, describe, expect, it, vi } from "vitest";

const runGuardrailsMock = vi.fn();
const generateTier3SqlMock = vi.fn();
const tier4FallbackMock = vi.fn();
const queryMock = vi.fn();
const queryTier4Mock = vi.fn();

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
  queryTier4: queryTier4Mock,
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
    queryTier4Mock.mockReset();
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

  it("executes tier3 SQL through query() (app_runtime, sem.*/ont.* only), never queryTier4()", async () => {
    runGuardrailsMock.mockResolvedValue({ verdict: "allow" });
    generateTier3SqlMock.mockResolvedValue({
      kind: "sql",
      sql: "SELECT * FROM sem.faers_case_summary LIMIT 10",
    });
    queryMock.mockResolvedValue([{ safetyreportid: "1" }]);

    const response = await POST(
      makeRequest({ question: "How many cases for imatinib?", sessionId: "s1" }),
    );
    const json = await response.json();

    expect(json.kind).toBe("tier3");
    expect(queryMock).toHaveBeenCalledWith(
      "SELECT * FROM sem.faers_case_summary LIMIT 10",
    );
    expect(queryTier4Mock).not.toHaveBeenCalled();
  });

  it("executes tier4 SQL through queryTier4() (app_runtime_tier4, raw faers.*/ct.* grant), never query()", async () => {
    runGuardrailsMock.mockResolvedValue({ verdict: "allow" });
    generateTier3SqlMock.mockResolvedValue({ kind: "no_match" });
    tier4FallbackMock.mockResolvedValue({
      kind: "sql",
      sql: "SELECT * FROM faers.report LIMIT 10",
    });
    queryTier4Mock.mockResolvedValue([{ safetyreportid: "1" }]);

    const response = await POST(
      makeRequest({ question: "What's in the flibbertigibbet column?", sessionId: "s1" }),
    );
    const json = await response.json();

    expect(json.kind).toBe("tier4");
    expect(queryTier4Mock).toHaveBeenCalledWith("SELECT * FROM faers.report LIMIT 10");
    expect(queryMock).not.toHaveBeenCalled();
  });
});
