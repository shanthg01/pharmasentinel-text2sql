import { beforeEach, describe, expect, it, vi } from "vitest";

const runGoldCasesMock = vi.fn();

vi.mock("../../../../../scripts/eval/goldCases", () => ({
  goldCases: [
    { id: "a", category: "cat1", split: "train" },
    { id: "b", category: "cat1", split: "test" },
  ],
}));

vi.mock("../../../../../scripts/eval/runner", () => ({
  runGoldCases: runGoldCasesMock,
}));

const { GET } = await import("./route");

describe("GET /api/evaluation/run", () => {
  beforeEach(() => {
    runGoldCasesMock.mockReset();
  });

  it("returns the summary plus totalCases derived from goldCases.length", async () => {
    runGoldCasesMock.mockResolvedValue({
      results: [
        { id: "a", category: "cat1", split: "train", pass: true, detail: "ok", durationMs: 1 },
        { id: "b", category: "cat1", split: "test", pass: false, detail: "nope", durationMs: 2 },
      ],
      totalPass: 1,
      totalFail: 1,
      byCategory: { cat1: { pass: 1, fail: 1 } },
      bySplit: { train: { pass: 1, fail: 0 }, test: { pass: 0, fail: 1 } },
    });

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.totalCases).toBe(2);
    expect(json.totalPass).toBe(1);
    expect(json.totalFail).toBe(1);
    expect(json.byCategory.cat1).toEqual({ pass: 1, fail: 1 });
    expect(runGoldCasesMock).toHaveBeenCalledWith([
      { id: "a", category: "cat1", split: "train" },
      { id: "b", category: "cat1", split: "test" },
    ]);
  });

  it("handles an empty/zero-total summary cleanly rather than throwing", async () => {
    runGoldCasesMock.mockResolvedValue({
      results: [],
      totalPass: 0,
      totalFail: 0,
      byCategory: {},
      bySplit: { train: { pass: 0, fail: 0 }, test: { pass: 0, fail: 0 } },
    });

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.totalPass).toBe(0);
    expect(json.totalFail).toBe(0);
    expect(json.results).toEqual([]);
  });

  it("returns a 500 with an error message when runGoldCases throws", async () => {
    runGoldCasesMock.mockRejectedValue(new Error("boom"));

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toContain("boom");
  });
});
