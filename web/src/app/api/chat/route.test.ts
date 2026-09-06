import { beforeEach, describe, expect, it, vi } from "vitest";

const runGuardrailsMock = vi.fn();
const generateTier3SqlMock = vi.fn();
const tier4FallbackMock = vi.fn();
const queryMock = vi.fn();
const queryTier4Mock = vi.fn();
const getHistoryMock = vi.fn();
const appendTurnMock = vi.fn();
const streamAnswerMock = vi.fn();

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
vi.mock("@/lib/session/store", () => ({
  getHistory: getHistoryMock,
  appendTurn: appendTurnMock,
}));
// `renderAnswer.ts` makes its own real Anthropic streaming call
// (`client.messages.stream()`, exercised/mocked directly in
// `renderAnswer.test.ts`) -- at the route level we mock the module the same
// way tier3/tier4 are mocked above, so these tests exercise route.ts's own
// wiring (does it call streamAnswer with the right args, does it frame the
// wire format correctly) without needing to fake the Anthropic SDK twice.
vi.mock("@/lib/render/renderAnswer", () => ({
  streamAnswer: streamAnswerMock,
}));

const { POST } = await import("./route");

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Drains a streamed `Response` body into `{ metadata, text }`, mirroring
 * exactly what `apiClient.ts`'s `postChatStream` does with the wire format
 * documented at the top of `route.ts`. */
async function readStreamedResponse(
  response: Response,
): Promise<{ metadata: Record<string, unknown>; text: string }> {
  const raw = await response.text();
  const newlineIndex = raw.indexOf("\n");
  const metadata = JSON.parse(raw.slice(0, newlineIndex));
  const text = raw.slice(newlineIndex + 1);
  return { metadata, text };
}

/** A minimal async generator standing in for `streamAnswer`'s real
 * behavior, mirroring how `classify.test.ts`/`tier3.test.ts` mock their
 * respective Anthropic SDK call sites with a canned return value. */
async function* fakeAnswerChunks(chunks: string[]): AsyncGenerator<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("POST /api/chat", () => {
  beforeEach(() => {
    runGuardrailsMock.mockReset();
    generateTier3SqlMock.mockReset();
    tier4FallbackMock.mockReset();
    queryMock.mockReset();
    queryTier4Mock.mockReset();
    getHistoryMock.mockReset();
    appendTurnMock.mockReset();
    streamAnswerMock.mockReset();
    getHistoryMock.mockReturnValue([]);
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

  it("loads session history and passes it through to generateTier3Sql on a follow-up request", async () => {
    const priorHistory = [
      { role: "user" as const, text: "How many cases for imatinib in 2022?" },
      { role: "assistant" as const, text: "Generated tier3 SQL: SELECT ... LIMIT 10" },
    ];
    getHistoryMock.mockReturnValue(priorHistory);
    runGuardrailsMock.mockResolvedValue({ verdict: "allow" });
    generateTier3SqlMock.mockResolvedValue({
      kind: "sql",
      sql: "SELECT * FROM sem.faers_case_summary LIMIT 10",
    });
    queryMock.mockResolvedValue([]);

    await POST(makeRequest({ question: "What about last year?", sessionId: "s1" }));

    expect(getHistoryMock).toHaveBeenCalledWith("s1");
    expect(generateTier3SqlMock).toHaveBeenCalledWith(
      "What about last year?",
      priorHistory,
    );
  });

  it("does not load history for a request with a missing/blank sessionId, and never appends a turn", async () => {
    runGuardrailsMock.mockResolvedValue({ verdict: "allow" });
    generateTier3SqlMock.mockResolvedValue({
      kind: "sql",
      sql: "SELECT * FROM sem.faers_case_summary LIMIT 10",
    });
    queryMock.mockResolvedValue([]);

    await POST(makeRequest({ question: "How many cases for imatinib?", sessionId: "  " }));

    expect(getHistoryMock).not.toHaveBeenCalled();
    expect(generateTier3SqlMock).toHaveBeenCalledWith(
      "How many cases for imatinib?",
      [],
    );
    expect(appendTurnMock).not.toHaveBeenCalled();
  });

  it("appends a user turn and an assistant turn summarizing the SQL after a successful tier3 call", async () => {
    runGuardrailsMock.mockResolvedValue({ verdict: "allow" });
    generateTier3SqlMock.mockResolvedValue({
      kind: "sql",
      sql: "SELECT * FROM sem.faers_case_summary LIMIT 10",
    });
    queryMock.mockResolvedValue([]);

    await POST(makeRequest({ question: "How many cases for imatinib?", sessionId: "s1" }));

    expect(appendTurnMock).toHaveBeenCalledTimes(2);
    expect(appendTurnMock).toHaveBeenNthCalledWith(1, "s1", {
      role: "user",
      text: "How many cases for imatinib?",
    });
    expect(appendTurnMock).toHaveBeenNthCalledWith(2, "s1", {
      role: "assistant",
      text: expect.stringContaining("SELECT * FROM sem.faers_case_summary LIMIT 10"),
    });
  });

  it("still appends a turn on a tier3 clarify response (so context accumulates across a clarify)", async () => {
    runGuardrailsMock.mockResolvedValue({ verdict: "allow" });
    generateTier3SqlMock.mockResolvedValue({
      kind: "clarify",
      question: "Which drug did you mean?",
    });

    await POST(makeRequest({ question: "How many cases?", sessionId: "s1" }));

    expect(appendTurnMock).toHaveBeenCalledTimes(2);
    expect(appendTurnMock).toHaveBeenNthCalledWith(1, "s1", {
      role: "user",
      text: "How many cases?",
    });
    expect(appendTurnMock).toHaveBeenNthCalledWith(2, "s1", {
      role: "assistant",
      text: expect.stringContaining("Which drug did you mean?"),
    });
  });

  it("does not append any turn on a guardrail reject", async () => {
    runGuardrailsMock.mockResolvedValue({
      verdict: "reject",
      category: "off_topic",
      message: "I can only answer questions about drug safety data.",
    });

    await POST(makeRequest({ question: "What's the weather today?", sessionId: "s1" }));

    expect(appendTurnMock).not.toHaveBeenCalled();
  });

  describe("stream: true", () => {
    it("streams the metadata header + NL answer for a successful tier3 result, never touching streamAnswer's rows in the JSON path", async () => {
      runGuardrailsMock.mockResolvedValue({ verdict: "allow" });
      generateTier3SqlMock.mockResolvedValue({
        kind: "sql",
        sql: "SELECT count(*) AS n FROM sem.faers_case_summary",
      });
      queryMock.mockResolvedValue([{ n: 70 }]);
      streamAnswerMock.mockReturnValue(
        fakeAnswerChunks(["There were ", "70 reports."]),
      );

      const response = await POST(
        makeRequest({
          question: "How many adverse event reports mention dupilumab?",
          sessionId: "s1",
          stream: true,
        }),
      );

      expect(response.headers.get("Content-Type")).toContain("text/plain");
      const { metadata, text } = await readStreamedResponse(response);

      expect(metadata).toEqual({
        kind: "tier3",
        sql: "SELECT count(*) AS n FROM sem.faers_case_summary",
        rows: [{ n: 70 }],
      });
      expect(text).toBe("There were 70 reports.");
      expect(streamAnswerMock).toHaveBeenCalledWith(
        "How many adverse event reports mention dupilumab?",
        "tier3",
        "SELECT count(*) AS n FROM sem.faers_case_summary",
        [{ n: 70 }],
      );
    });

    it("streams tier4 results through queryTier4, same metadata contract as tier3", async () => {
      runGuardrailsMock.mockResolvedValue({ verdict: "allow" });
      generateTier3SqlMock.mockResolvedValue({ kind: "no_match" });
      tier4FallbackMock.mockResolvedValue({
        kind: "sql",
        sql: "SELECT * FROM faers.report LIMIT 1",
      });
      queryTier4Mock.mockResolvedValue([{ safetyreportid: "1" }]);
      streamAnswerMock.mockReturnValue(fakeAnswerChunks(["One matching report."]));

      const response = await POST(
        makeRequest({ question: "raw table question", sessionId: "s1", stream: true }),
      );
      const { metadata, text } = await readStreamedResponse(response);

      expect(metadata.kind).toBe("tier4");
      expect(metadata.sql).toBe("SELECT * FROM faers.report LIMIT 1");
      expect(metadata.rows).toEqual([{ safetyreportid: "1" }]);
      expect(text).toBe("One matching report.");
      expect(queryMock).not.toHaveBeenCalled();
    });

    it("streams a guardrail reject's message as a single chunk, without calling streamAnswer", async () => {
      runGuardrailsMock.mockResolvedValue({
        verdict: "reject",
        category: "off_topic",
        message: "I can only answer questions about drug safety data.",
      });

      const response = await POST(
        makeRequest({ question: "What's the weather?", sessionId: "s1", stream: true }),
      );
      const { metadata, text } = await readStreamedResponse(response);

      expect(metadata).toEqual({ kind: "reject", category: "off_topic" });
      expect(text).toBe("I can only answer questions about drug safety data.");
      expect(streamAnswerMock).not.toHaveBeenCalled();
    });

    it("streams a tier3 clarify question as a single chunk", async () => {
      runGuardrailsMock.mockResolvedValue({ verdict: "allow" });
      generateTier3SqlMock.mockResolvedValue({
        kind: "clarify",
        question: "Which drug did you mean?",
      });

      const response = await POST(
        makeRequest({ question: "How many cases?", sessionId: "s1", stream: true }),
      );
      const { metadata, text } = await readStreamedResponse(response);

      expect(metadata).toEqual({ kind: "clarify", question: "Which drug did you mean?" });
      expect(text).toBe("Which drug did you mean?");
    });

    it("streams the no_answer message as a single chunk", async () => {
      runGuardrailsMock.mockResolvedValue({ verdict: "allow" });
      generateTier3SqlMock.mockResolvedValue({ kind: "no_match" });
      tier4FallbackMock.mockResolvedValue({ kind: "no_answer" });

      const response = await POST(
        makeRequest({ question: "flibbertigibbet?", sessionId: "s1", stream: true }),
      );
      const { metadata, text } = await readStreamedResponse(response);

      expect(metadata).toEqual({ kind: "no_answer" });
      expect(text).toBe("I couldn't find a way to answer that from the available data.");
    });

    it("still appends turns under stream: true, same as the non-streaming path", async () => {
      runGuardrailsMock.mockResolvedValue({ verdict: "allow" });
      generateTier3SqlMock.mockResolvedValue({
        kind: "sql",
        sql: "SELECT * FROM sem.faers_case_summary LIMIT 10",
      });
      queryMock.mockResolvedValue([]);
      streamAnswerMock.mockReturnValue(fakeAnswerChunks(["No rows."]));

      const response = await POST(
        makeRequest({ question: "How many cases for imatinib?", sessionId: "s1", stream: true }),
      );
      await readStreamedResponse(response);

      expect(appendTurnMock).toHaveBeenCalledTimes(2);
      expect(appendTurnMock).toHaveBeenNthCalledWith(2, "s1", {
        role: "assistant",
        text: expect.stringContaining(
          "SELECT * FROM sem.faers_case_summary LIMIT 10",
        ),
      });
    });

    it("omitting stream (falsy/absent) never calls streamAnswer and returns the plain JSON body unchanged", async () => {
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

      expect(response.headers.get("Content-Type")).toContain("application/json");
      expect(json).toEqual({
        kind: "tier3",
        sql: "SELECT * FROM sem.faers_case_summary LIMIT 10",
        rows: [{ safetyreportid: "1" }],
      });
      expect(streamAnswerMock).not.toHaveBeenCalled();
    });
  });
});
