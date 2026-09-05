import { describe, expect, it } from "vitest";
import { validateSql } from "./astValidator";

const TIER3_ALLOWLIST = [
  "sem.faers_case_summary",
  "sem.faers_drug_reaction",
];

describe("validateSql", () => {
  it("passes a valid single-table select against the allowlist", () => {
    const result = validateSql(
      "SELECT case_id FROM sem.faers_case_summary LIMIT 10",
      { allowedTables: TIER3_ALLOWLIST },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects DROP TABLE", () => {
    const result = validateSql("DROP TABLE sem.faers_case_summary", {
      allowedTables: TIER3_ALLOWLIST,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects DELETE", () => {
    const result = validateSql("DELETE FROM sem.faers_case_summary", {
      allowedTables: TIER3_ALLOWLIST,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects UPDATE", () => {
    const result = validateSql(
      "UPDATE sem.faers_case_summary SET case_id = 1",
      { allowedTables: TIER3_ALLOWLIST },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a multi-statement injection attempt", () => {
    const result = validateSql(
      "SELECT case_id FROM sem.faers_case_summary; DROP TABLE sem.faers_case_summary;--",
      { allowedTables: TIER3_ALLOWLIST },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a select against a non-allowlisted table", () => {
    const result = validateSql("SELECT * FROM faers.raw_case", {
      allowedTables: TIER3_ALLOWLIST,
    });
    expect(result.ok).toBe(false);
  });

  it("injects a LIMIT when the query has none", () => {
    const result = validateSql(
      "SELECT case_id FROM sem.faers_case_summary",
      { allowedTables: TIER3_ALLOWLIST, maxLimit: 1000 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sql.toUpperCase()).toContain("LIMIT");
    }
  });

  it("caps an excessive LIMIT down to maxLimit", () => {
    const result = validateSql(
      "SELECT case_id FROM sem.faers_case_summary LIMIT 999999",
      { allowedTables: TIER3_ALLOWLIST, maxLimit: 1000 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sql).not.toContain("999999");
    }
  });
});
