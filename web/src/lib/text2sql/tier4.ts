import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { validateSql, type ValidateSqlResult } from "@/lib/sql/astValidator";
import {
  searchFieldCandidates,
  type FieldCandidate,
} from "@/lib/sql/fieldSearch";

export type Tier4Result = { kind: "sql"; sql: string } | { kind: "no_answer" };

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

const TIER4_TOOL: Tool = {
  name: "emit_tier4_result",
  description:
    "Return the structured Tier 4 raw-table fallback SQL result for the user's question.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["sql", "no_answer"] },
      sql: { type: "string" },
    },
    required: ["kind"],
  },
};

interface RawTier4ModelOutput {
  kind?: string;
  sql?: string;
}

/** Distinct schema-qualified tables referenced by a candidate set, for use
 * as an `astValidator.ts` allowlist. Deliberately narrow: exactly the
 * tables field search surfaced, never a blanket `faers.*`/`ct.*`
 * allowlist. */
function candidateTables(candidates: FieldCandidate[]): string[] {
  return Array.from(new Set(candidates.map((c) => c.schemaQualifiedTable)));
}

function buildSystemPrompt(candidates: FieldCandidate[]): string {
  const byTable = new Map<string, FieldCandidate[]>();
  for (const candidate of candidates) {
    const list = byTable.get(candidate.schemaQualifiedTable) ?? [];
    list.push(candidate);
    byTable.set(candidate.schemaQualifiedTable, list);
  }

  const candidateText = Array.from(byTable.entries())
    .map(([table, cols]) => {
      const columnLines = cols
        .map(
          (c) =>
            `  - ${c.columnName} ("${c.humanLabel}", similarity ${c.similarity.toFixed(2)})`,
        )
        .join("\n");
      return `${table}:\n${columnLines}`;
    })
    .join("\n");

  return `You are the Tier 4 last-resort fallback SQL generator for
PharmaSentinel. Tier 3 (the governed sem.* semantic layer) could not answer
this question, so you are searching the raw faers.*/ct.* tables directly
via a small set of candidate columns surfaced by similarity search.

You may ONLY reference the exact tables and columns listed below -- never
invent a table or column, and never assume any OTHER column exists on
these tables beyond what is listed, even if it seems like it should. If
the listed candidates are not enough to answer the question, respond with
no_answer instead of guessing at unlisted columns.

Candidate tables/columns (ranked by relevance to the question):
${candidateText}

Call the emit_tier4_result tool exactly once with one of:
  {"kind": "sql", "sql": "<a single SELECT statement>"}
  {"kind": "no_answer"}`;
}

async function callModel(
  client: Anthropic,
  systemPrompt: string,
  userContent: string,
): Promise<RawTier4ModelOutput | null> {
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
    tools: [TIER4_TOOL],
    tool_choice: { type: "tool", name: TIER4_TOOL.name },
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  return toolUse ? (toolUse.input as RawTier4ModelOutput) : null;
}

function tryValidate(
  sql: string,
  allowedTables: string[],
): ValidateSqlResult | null {
  try {
    return validateSql(sql, { allowedTables });
  } catch {
    return null;
  }
}

/**
 * Tier 4 last-resort fallback: attempts to answer questions Tier 3
 * couldn't ground in the `sem.*` semantic layer, by searching the raw
 * FAERS / ClinicalTrials.gov tables via the ontology (Tier 1) similarity
 * index (`lib/sql/fieldSearch.ts`).
 *
 * Order of operations:
 *   1. Rank candidate raw columns via `searchFieldCandidates`. If nothing
 *      clears the similarity threshold, return `no_answer` immediately --
 *      never fall through to an ungrounded LLM call over the full raw
 *      schema.
 *   2. Call Claude with a prompt grounded ONLY on those candidates (never
 *      the full raw schema -- this is a long-tail fallback, not a second
 *      Tier 3).
 *   3. Validate any returned SQL through `astValidator.ts` with an
 *      allowlist built from exactly the candidates' own tables. On a
 *      validation failure, retry once with a repair prompt; if that also
 *      fails, return `no_answer`.
 */
export async function tier4Fallback(question: string): Promise<Tier4Result> {
  const candidates = await searchFieldCandidates(question);
  if (candidates.length === 0) {
    return { kind: "no_answer" };
  }

  const allowedTables = candidateTables(candidates);
  const client = getClient();
  const systemPrompt = buildSystemPrompt(candidates);

  const raw = await callModel(client, systemPrompt, question);
  if (!raw || raw.kind !== "sql" || !raw.sql) {
    return { kind: "no_answer" };
  }

  const validation = tryValidate(raw.sql, allowedTables);
  if (validation?.ok) {
    return { kind: "sql", sql: validation.sql };
  }

  const reason =
    validation?.ok === false ? validation.reason : "SQL could not be parsed.";
  const repairPrompt = `The SQL you returned failed validation: ${reason}

Original SQL:
${raw.sql}

Call emit_tier4_result again with a corrected result, still using ONLY the
tables/columns listed in the system prompt.`;

  const repaired = await callModel(client, systemPrompt, repairPrompt);
  if (repaired?.kind === "sql" && repaired.sql) {
    const repairedValidation = tryValidate(repaired.sql, allowedTables);
    if (repairedValidation?.ok) {
      return { kind: "sql", sql: repairedValidation.sql };
    }
  }

  return { kind: "no_answer" };
}
