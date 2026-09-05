import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("@/lib/db/client", () => ({
  query: queryMock,
}));

const {
  loadSemanticViewCatalog,
  formatCatalogForPrompt,
  catalogTableNames,
  __resetSemanticCatalogCacheForTests,
} = await import("./semanticCatalog");

describe("loadSemanticViewCatalog", () => {
  beforeEach(() => {
    queryMock.mockReset();
    __resetSemanticCatalogCacheForTests();
  });

  it("groups information_schema.columns rows by table into SemanticViewInfo[]", async () => {
    queryMock.mockResolvedValue([
      {
        table_name: "faers_case_summary",
        column_name: "safetyreportid",
        data_type: "text",
        ordinal_position: 1,
      },
      {
        table_name: "faers_case_summary",
        column_name: "receivedate",
        data_type: "date",
        ordinal_position: 2,
      },
      {
        table_name: "trials_summary",
        column_name: "nct_id",
        data_type: "text",
        ordinal_position: 1,
      },
    ]);

    const catalog = await loadSemanticViewCatalog();

    expect(catalog).toEqual([
      {
        schemaQualifiedName: "sem.faers_case_summary",
        columns: [
          { name: "safetyreportid", dataType: "text" },
          { name: "receivedate", dataType: "date" },
        ],
      },
      {
        schemaQualifiedName: "sem.trials_summary",
        columns: [{ name: "nct_id", dataType: "text" }],
      },
    ]);
  });

  it("queries information_schema.columns filtered to table_schema = 'sem'", async () => {
    queryMock.mockResolvedValue([]);
    await loadSemanticViewCatalog();

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql] = queryMock.mock.calls[0] as [string];
    expect(sql).toMatch(/information_schema\.columns/i);
    expect(sql).toMatch(/table_schema\s*=\s*'sem'/i);
  });

  it("caches the result across calls -- only queries the db once", async () => {
    queryMock.mockResolvedValue([
      {
        table_name: "trials_summary",
        column_name: "nct_id",
        data_type: "text",
        ordinal_position: 1,
      },
    ]);

    await loadSemanticViewCatalog();
    await loadSemanticViewCatalog();
    await loadSemanticViewCatalog();

    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe("formatCatalogForPrompt", () => {
  it("renders one line per view with column name + data type", () => {
    const text = formatCatalogForPrompt([
      {
        schemaQualifiedName: "sem.faers_case_summary",
        columns: [
          { name: "safetyreportid", dataType: "text" },
          { name: "receivedate", dataType: "date" },
        ],
      },
    ]);

    expect(text).toBe(
      "sem.faers_case_summary(safetyreportid text, receivedate date)",
    );
  });
});

describe("catalogTableNames", () => {
  it("extracts the schema-qualified name from each view", () => {
    const names = catalogTableNames([
      { schemaQualifiedName: "sem.faers_case_summary", columns: [] },
      { schemaQualifiedName: "sem.trials_summary", columns: [] },
    ]);

    expect(names).toEqual(["sem.faers_case_summary", "sem.trials_summary"]);
  });
});
