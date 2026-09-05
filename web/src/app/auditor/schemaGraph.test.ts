import { describe, expect, it } from "vitest";
import { SCHEMA_EDGES, SCHEMA_NODES } from "./schemaGraph";

describe("schemaGraph", () => {
  it("has at least one node for every tier", () => {
    const tiers = new Set(SCHEMA_NODES.map((n) => n.tier));
    expect(tiers.has("ont")).toBe(true);
    expect(tiers.has("sem")).toBe(true);
  });

  it("has no duplicate node ids", () => {
    const ids = SCHEMA_NODES.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every edge's source references a real node id", () => {
    const nodeIds = new Set(SCHEMA_NODES.map((n) => n.id));
    for (const edge of SCHEMA_EDGES) {
      expect(nodeIds.has(edge.source)).toBe(true);
    }
  });

  it("every edge's target references a real node id", () => {
    const nodeIds = new Set(SCHEMA_NODES.map((n) => n.id));
    for (const edge of SCHEMA_EDGES) {
      expect(nodeIds.has(edge.target)).toBe(true);
    }
  });

  it("has no self-referencing edges", () => {
    for (const edge of SCHEMA_EDGES) {
      expect(edge.source).not.toBe(edge.target);
    }
  });

  it("includes the real sem.faers_case_summary <-> ont.drug_class/ont.meddra_pt joins", () => {
    const hasDrugClassJoin = SCHEMA_EDGES.some(
      (e) => e.source === "sem.faers_case_summary" && e.target === "ont.drug_class",
    );
    const hasMeddraJoin = SCHEMA_EDGES.some(
      (e) => e.source === "sem.faers_case_summary" && e.target === "ont.meddra_pt",
    );
    expect(hasDrugClassJoin).toBe(true);
    expect(hasMeddraJoin).toBe(true);
  });

  it("includes the real sem.drug_trial_ae_link <-> ont.drug_synonym join", () => {
    const hasSynonymJoin = SCHEMA_EDGES.some(
      (e) => e.source === "sem.drug_trial_ae_link" && e.target === "ont.drug_synonym",
    );
    expect(hasSynonymJoin).toBe(true);
  });

  it("every node id is schema-qualified with a known tier prefix", () => {
    for (const node of SCHEMA_NODES) {
      expect(node.id.startsWith(`${node.tier}.`)).toBe(true);
    }
  });
});
