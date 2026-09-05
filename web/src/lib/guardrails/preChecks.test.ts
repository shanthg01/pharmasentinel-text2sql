import { describe, expect, it } from "vitest";
import { runPreChecks } from "./preChecks";

describe("runPreChecks", () => {
  it("rejects empty/whitespace-only input", () => {
    const result = runPreChecks("   ");
    expect(result?.verdict).toBe("reject");
    expect(result?.category).toBe("empty_input");
  });

  it("rejects a named-patient identity request", () => {
    const result = runPreChecks("Who is the patient in case 12345?");
    expect(result?.verdict).toBe("reject");
    expect(result?.category).toBe("phi_request");
  });

  it("asks to clarify a too-short question", () => {
    const result = runPreChecks("metformin");
    expect(result?.verdict).toBe("clarify");
  });

  it("falls through (returns null) for a reasonable in-scope question", () => {
    const result = runPreChecks(
      "How many serious adverse events were reported for metformin in 2023?",
    );
    expect(result).toBeNull();
  });
});
