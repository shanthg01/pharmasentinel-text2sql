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

const { tier4Fallback } = await import("./tier4");

function toolResponse(input: Record<string, unknown>) {
  return {
    content: [
      { type: "tool_use", id: "toolu_1", name: "emit_tier4_result", input },
    ],
  };
}

const ONE_CANDIDATE_ROW = [
  {
    schema_name: "faers",
    table_name: "report",
    column_name: "serious",
    human_label: "Serious Case Flag",
    similarity: 0.55,
  },
];

describe("tier4Fallback", () => {
  beforeEach(() => {
    createMock.mockReset();
    queryMock.mockReset();
  });

  it("returns no_answer without calling the model when field search finds nothing", async () => {
    queryMock.mockResolvedValue([]);

    const result = await tier4Fallback("completely unrelated gibberish");

    expect(result).toEqual({ kind: "no_answer" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("calls the model grounded on the candidate columns and validates its SQL", async () => {
    queryMock.mockResolvedValue(ONE_CANDIDATE_ROW);
    createMock.mockResolvedValue(
      toolResponse({ kind: "sql", sql: "SELECT serious FROM faers.report" }),
    );

    const result = await tier4Fallback("How many serious cases?");

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("sql");
    if (result.kind === "sql") {
      expect(result.sql).toMatch(/faers"?\."?report/i);
      expect(result.sql).toMatch(/LIMIT/i);
    }

    // The system prompt should be grounded only on the surfaced candidate,
    // not a blanket raw-schema description.
    const callArgs = createMock.mock.calls[0]![0] as { system: string };
    expect(callArgs.system).toMatch(/faers\.report/);
    expect(callArgs.system).toMatch(/Serious Case Flag/);
  });

  it("returns no_answer when the model itself says no_answer", async () => {
    queryMock.mockResolvedValue(ONE_CANDIDATE_ROW);
    createMock.mockResolvedValue(toolResponse({ kind: "no_answer" }));

    const result = await tier4Fallback("How many serious cases?");
    expect(result).toEqual({ kind: "no_answer" });
  });

  it("retries once with a repair prompt after a validation failure, then succeeds", async () => {
    queryMock.mockResolvedValue(ONE_CANDIDATE_ROW);
    createMock
      .mockResolvedValueOnce(
        toolResponse({ kind: "sql", sql: "SELECT * FROM ct.study" }), // not in the candidate allowlist
      )
      .mockResolvedValueOnce(
        toolResponse({ kind: "sql", sql: "SELECT serious FROM faers.report" }),
      );

    const result = await tier4Fallback("How many serious cases?");

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe("sql");
    if (result.kind === "sql") {
      expect(result.sql).toMatch(/faers"?\."?report/i);
    }

    const secondCallArgs = createMock.mock.calls[1]![0] as {
      messages: { content: string }[];
    };
    expect(secondCallArgs.messages[0]!.content).toMatch(/not in the allowlist/i);
  });

  it("returns no_answer when the repair retry also fails validation", async () => {
    queryMock.mockResolvedValue(ONE_CANDIDATE_ROW);
    createMock
      .mockResolvedValueOnce(
        toolResponse({ kind: "sql", sql: "SELECT * FROM ct.study" }),
      )
      .mockResolvedValueOnce(
        toolResponse({ kind: "sql", sql: "SELECT * FROM ct.intervention" }),
      );

    const result = await tier4Fallback("How many serious cases?");
    expect(result).toEqual({ kind: "no_answer" });
  });

  it("returns no_answer when the model returns no tool_use block", async () => {
    queryMock.mockResolvedValue(ONE_CANDIDATE_ROW);
    createMock.mockResolvedValue({ content: [{ type: "text", text: "uh" }] });

    const result = await tier4Fallback("How many serious cases?");
    expect(result).toEqual({ kind: "no_answer" });
  });
});
