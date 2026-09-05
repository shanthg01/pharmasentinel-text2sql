import { describe, expect, it } from "vitest";
import {
  SEED_VERIFIED_QUERIES,
  findVerifiedMatch,
  type VerifiedQuery,
} from "./verifiedQueries";

describe("findVerifiedMatch", () => {
  const candidates: VerifiedQuery[] = [
    { question: "How many reports mention imatinib?", sql: "SELECT 1" },
    { question: "What trials study aspirin?", sql: "SELECT 2" },
  ];

  it("matches an exact question", () => {
    const match = findVerifiedMatch(
      "How many reports mention imatinib?",
      candidates,
    );
    expect(match?.sql).toBe("SELECT 1");
  });

  it("matches case-insensitively and ignoring surrounding whitespace/punctuation", () => {
    const match = findVerifiedMatch(
      "  HOW MANY reports MENTION imatinib   ",
      candidates,
    );
    expect(match?.sql).toBe("SELECT 1");
  });

  it("matches regardless of trailing punctuation", () => {
    const match = findVerifiedMatch(
      "What trials study aspirin???",
      candidates,
    );
    expect(match?.sql).toBe("SELECT 2");
  });

  it("returns null when there is no match", () => {
    const match = findVerifiedMatch(
      "What is the capital of France?",
      candidates,
    );
    expect(match).toBeNull();
  });

  it("returns null on an empty candidate list", () => {
    expect(findVerifiedMatch("anything", [])).toBeNull();
  });

  it("does not fuzzy-match a paraphrase (documented simplification)", () => {
    // "reports" vs "adverse event reports" -- not an exact normalized
    // match, so this must miss even though a human would consider it the
    // same question. See the module-level comment in verifiedQueries.ts.
    const match = findVerifiedMatch(
      "How many adverse event reports mention imatinib?",
      candidates,
    );
    expect(match).toBeNull();
  });
});

describe("SEED_VERIFIED_QUERIES", () => {
  it("is non-empty and every entry has a question and sql", () => {
    expect(SEED_VERIFIED_QUERIES.length).toBeGreaterThanOrEqual(3);
    for (const entry of SEED_VERIFIED_QUERIES) {
      expect(entry.question.length).toBeGreaterThan(0);
      expect(entry.sql.length).toBeGreaterThan(0);
    }
  });

  it("every seed SQL string references only sem.* views", () => {
    for (const entry of SEED_VERIFIED_QUERIES) {
      expect(entry.sql).toMatch(/FROM sem\./);
    }
  });
});
