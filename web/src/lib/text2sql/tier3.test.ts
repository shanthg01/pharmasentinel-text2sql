import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();
const queryMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: createMock },
  })),
}));

vi.mock("@/lib/db/client", () => ({
  query: queryMock,
}));

const { generateTier3Sql } = await import("./tier3");
const { __resetSemanticCatalogCacheForTests } = await import(
  "./semanticCatalog"
);
const { SEED_VERIFIED_QUERIES } = await import("./verifiedQueries");

/** Wraps a tool-call `input` payload the way `messages.create` responds when
 * `tool_choice` forces a single tool call. */
function toolResponse(input: Record<string, unknown>) {
  return {
    content: [
      { type: "tool_use", id: "toolu_1", name: "emit_tier3_result", input },
    ],
  };
}

/** Catalog rows covering every sem.* table the seed verified queries and
 * this file's LLM-path fixtures reference, so astValidator's allowlist
 * check passes for all of them. */
const CATALOG_ROWS = [
  {
    table_name: "faers_case_summary",
    column_name: "safetyreportid",
    data_type: "text",
    ordinal_position: 1,
  },
  {
    table_name: "faers_case_summary",
    column_name: "serious",
    data_type: "boolean",
    ordinal_position: 2,
  },
  {
    table_name: "faers_case_summary",
    column_name: "primary_suspect_ingredients",
    data_type: "ARRAY",
    ordinal_position: 3,
  },
  {
    table_name: "trials_summary",
    column_name: "nct_id",
    data_type: "text",
    ordinal_position: 1,
  },
];

describe("generateTier3Sql", () => {
  beforeEach(() => {
    createMock.mockReset();
    queryMock.mockReset();
    __resetSemanticCatalogCacheForTests();
    queryMock.mockResolvedValue(CATALOG_ROWS);
  });

  it("short-circuits on a verified-query match without calling the model", async () => {
    const seed = SEED_VERIFIED_QUERIES[0]!;
    const result = await generateTier3Sql(seed.question, []);

    expect(result.kind).toBe("sql");
    if (result.kind === "sql") {
      expect(result.sql).toMatch(/sem"?\."?faers_case_summary/i);
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it("calls the model and validates its SQL when there is no verified match", async () => {
    createMock.mockResolvedValue(
      toolResponse({
        kind: "sql",
        sql: "SELECT nct_id FROM sem.trials_summary",
        explanation: "Lists trial ids.",
      }),
    );

    const result = await generateTier3Sql(
      "What trials exist?",
      [],
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("sql");
    if (result.kind === "sql") {
      expect(result.sql).toMatch(/sem"?\."?trials_summary/i);
      expect(result.sql).toMatch(/LIMIT/i);
    }
  });

  it("passes through a clarify response from the model", async () => {
    createMock.mockResolvedValue(
      toolResponse({ kind: "clarify", question: "Which drug did you mean?" }),
    );

    const result = await generateTier3Sql("Tell me about the drug.", []);

    expect(result).toEqual({
      kind: "clarify",
      question: "Which drug did you mean?",
    });
  });

  it("returns no_match when the model returns no tool_use block", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "uh" }] });

    const result = await generateTier3Sql("anything", []);
    expect(result).toEqual({ kind: "no_match" });
  });

  it("returns no_match when the model explicitly says no_match", async () => {
    createMock.mockResolvedValue(toolResponse({ kind: "no_match" }));

    const result = await generateTier3Sql("anything", []);
    expect(result).toEqual({ kind: "no_match" });
  });

  it("retries once with a repair prompt after a validation failure, then succeeds", async () => {
    createMock
      .mockResolvedValueOnce(
        toolResponse({
          kind: "sql",
          sql: "SELECT * FROM faers.report", // not in the sem.* allowlist
          explanation: "bad",
        }),
      )
      .mockResolvedValueOnce(
        toolResponse({
          kind: "sql",
          sql: "SELECT nct_id FROM sem.trials_summary",
          explanation: "fixed",
        }),
      );

    const result = await generateTier3Sql("Some question", []);

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe("sql");
    if (result.kind === "sql") {
      expect(result.sql).toMatch(/sem"?\."?trials_summary/i);
    }

    // The repair prompt should include the validator's rejection reason.
    const secondCallArgs = createMock.mock.calls[1]![0] as {
      messages: { content: string }[];
    };
    expect(secondCallArgs.messages[0]!.content).toMatch(/not in the allowlist/i);
  });

  it("returns no_match when the repair retry also fails validation", async () => {
    createMock
      .mockResolvedValueOnce(
        toolResponse({ kind: "sql", sql: "SELECT * FROM faers.report" }),
      )
      .mockResolvedValueOnce(
        toolResponse({ kind: "sql", sql: "SELECT * FROM faers.drug" }),
      );

    const result = await generateTier3Sql("Some question", []);

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ kind: "no_match" });
  });

  it("falls through to the LLM path when a verified-cache entry fails validation", async () => {
    // Empty catalog -- even the verified seed query's sem.* table is no
    // longer "known", so it should fail validation and fall through.
    queryMock.mockResolvedValue([]);
    createMock.mockResolvedValue(
      toolResponse({ kind: "no_match" }),
    );

    const seed = SEED_VERIFIED_QUERIES[0]!;
    const result = await generateTier3Sql(seed.question, []);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ kind: "no_match" });
  });

  it("includes conversation history in the prompt sent to the model", async () => {
    createMock.mockResolvedValue(
      toolResponse({
        kind: "sql",
        sql: "SELECT nct_id FROM sem.trials_summary",
      }),
    );

    await generateTier3Sql("And what about phase 2?", [
      { role: "user", text: "Show me oncology trials." },
    ]);

    const callArgs = createMock.mock.calls[0]![0] as {
      messages: { content: string }[];
    };
    expect(callArgs.messages[0]!.content).toMatch(/oncology trials/i);
    expect(callArgs.messages[0]!.content).toMatch(/phase 2/i);
  });
});
