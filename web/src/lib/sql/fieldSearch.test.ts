import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("@/lib/db/client", () => ({
  query: queryMock,
}));

const { searchFieldCandidates, FIELD_SEARCH_SIMILARITY_THRESHOLD } =
  await import("./fieldSearch");

describe("searchFieldCandidates", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("maps information_schema-style rows into FieldCandidate[]", async () => {
    queryMock.mockResolvedValue([
      {
        schema_name: "faers",
        table_name: "report",
        column_name: "serious",
        human_label: "Serious Case Flag",
        similarity: 0.42,
      },
    ]);

    const candidates = await searchFieldCandidates("serious cases");

    expect(candidates).toEqual([
      {
        schemaQualifiedTable: "faers.report",
        columnName: "serious",
        humanLabel: "Serious Case Flag",
        similarity: 0.42,
      },
    ]);
  });

  it("queries ont.field_label with a similarity threshold and passes the question + limit as params", async () => {
    queryMock.mockResolvedValue([]);

    await searchFieldCandidates("adverse events for imatinib", 5);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ont\.field_label/i);
    expect(sql).toMatch(/similarity\(/i);
    expect(sql).toMatch(new RegExp(`>\\s*${FIELD_SEARCH_SIMILARITY_THRESHOLD}`));
    expect(params).toEqual(["adverse events for imatinib", 5]);
  });

  it("defaults to a limit of 10 when none is given", async () => {
    queryMock.mockResolvedValue([]);
    await searchFieldCandidates("some question");

    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["some question", 10]);
  });

  it("returns an empty array when nothing clears the similarity threshold", async () => {
    queryMock.mockResolvedValue([]);
    const candidates = await searchFieldCandidates("completely unrelated gibberish");
    expect(candidates).toEqual([]);
  });
});
