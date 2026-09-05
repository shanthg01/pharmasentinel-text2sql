import { describe, expect, it } from "vitest";
import { POST } from "./route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/auditor/inspect-sql", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/auditor/inspect-sql", () => {
  it("returns the referenced tables for a valid single-table select", async () => {
    const response = await POST(
      makeRequest({ sql: "SELECT case_id FROM sem.faers_case_summary LIMIT 10" }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.tables).toEqual(["sem.faers_case_summary"]);
  });

  it("returns every distinct table referenced across a join", async () => {
    const response = await POST(
      makeRequest({
        sql: "SELECT * FROM sem.drug_trial_ae_link JOIN sem.trials_summary ON true",
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.tables).toEqual(
      expect.arrayContaining(["sem.drug_trial_ae_link", "sem.trials_summary"]),
    );
  });

  it("normalizes an unqualified table name without a schema prefix", async () => {
    const response = await POST(makeRequest({ sql: "SELECT * FROM foo" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.tables).toEqual(["foo"]);
  });

  it("returns 400 for a missing sql field", async () => {
    const response = await POST(makeRequest({}));
    expect(response.status).toBe(400);
  });

  it("returns 400 for an empty sql string", async () => {
    const response = await POST(makeRequest({ sql: "   " }));
    expect(response.status).toBe(400);
  });

  it("returns 400 for genuinely unparseable SQL", async () => {
    const response = await POST(makeRequest({ sql: "SELECT FROM WHERE ;;; garbage" }));
    expect(response.status).toBe(400);
  });

  it("returns 400 for a non-JSON request body", async () => {
    const response = await POST(
      new Request("http://localhost/api/auditor/inspect-sql", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(response.status).toBe(400);
  });
});
