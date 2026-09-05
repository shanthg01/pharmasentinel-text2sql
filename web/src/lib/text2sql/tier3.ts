import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { validateSql, type ValidateSqlResult } from "@/lib/sql/astValidator";
import {
  loadSemanticViewCatalog,
  formatCatalogForPrompt,
  catalogTableNames,
} from "./semanticCatalog";
import { SEED_VERIFIED_QUERIES, findVerifiedMatch } from "./verifiedQueries";

export interface ConversationTurn {
  role: string;
  text: string;
}

export type Tier3Result =
  | { kind: "sql"; sql: string; explanation: string }
  | { kind: "clarify"; question: string }
  | { kind: "no_match" };

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

/**
 * Explicit FK / join contract between the `sem.*` views, transcribed from
 * the real view definitions/comments in `db/ddl/004_semantic_views.sql`.
 * Embedded verbatim in the Tier 3 system prompt so the model never invents
 * a join path these views don't actually support (e.g. joining
 * sem.trials_summary directly to sem.faers_case_summary, which has no
 * shared key outside of sem.drug_trial_ae_link).
 */
const RELATIONSHIP_NOTES = `
Relationships between these views (do not invent any other join path):
- sem.faers_case_summary and sem.faers_drug_reaction both derive from
  faers.report and key on safetyreportid, but are two different grains
  (one row per case, vs. one row per drug x reaction pair on a case) --
  they are not meant to be joined to each other; pick whichever one
  already matches the grain the question needs. They also differ in
  drug SCOPE, not just grain, and that distinction matters for which one
  answers a plain counting question correctly:
    - sem.faers_case_summary only ever reflects PRIMARY SUSPECT drugs
      (drugcharacterization = '1').
    - sem.faers_drug_reaction is deliberately UNFILTERED -- every drug on
      a report (suspect, concomitant, or interacting) crossed with every
      reaction on that same report.
  Standard FAERS pharmacovigilance convention treats the primary suspect
  drug as the analytically relevant one for a report -- so a plain
  question like "how many reports mention/involve drug X" or "how many
  adverse event reports for drug X" should default to
  sem.faers_case_summary (filtered on X being in primary_suspect_ingredients),
  NOT sem.faers_drug_reaction, even though X may also technically appear
  in faers_drug_reaction as a concomitant/interacting drug on other
  reports where it was never the suspect. Reach for
  sem.faers_drug_reaction instead only when the question is explicitly
  about co-occurrence regardless of suspect role (e.g. "which drugs
  were reported alongside X on any report", "what reactions were
  reported for X in any role").
- sem.trials_summary and sem.trials_outcomes both key on nct_id (one row
  per study, vs. one row per outcome measure on that study).
- sem.drug_trial_ae_link is the ONLY cross-dataset view linking trials to
  FAERS cases. It joins a trial's registered intervention_name to FAERS
  primary-suspect-drug cases via a shared canonical_ingredient column that
  the view derives (already, inside the view -- you never need to
  re-derive it) by normalizing both trial intervention names and FAERS
  active ingredients through ont.drug_synonym. There is NO shared key
  between sem.trials_summary and sem.faers_case_summary/faers_drug_reaction
  outside of this view -- never join them directly.
- The seriousness columns (serious, seriousnessdeath,
  seriousnesshospitalization, seriousnesslifethreatening,
  seriousnessdisabling) are FDA regulatory seriousness criteria, used
  throughout this platform as a documented PROXY for adverse event
  severity -- FAERS has no CTCAE numeric grade field. Never describe or
  treat them as a clinical trial "Grade".
- Raw drug/ingredient name columns -- sem.faers_case_summary's
  primary_suspect_ingredients (a text[]) and sem.faers_drug_reaction's
  active_ingredient -- preserve whatever case the source FAERS data used
  (typically upper-case, e.g. 'DUPILUMAB'), and are NOT guaranteed to
  match the case a user's question spells a drug name in. NEVER compare
  them with a bare case-sensitive '=' or 'x = ANY(...)' -- always match
  case-insensitively (e.g. 'ILIKE' for a scalar column, or
  'EXISTS (SELECT 1 FROM unnest(primary_suspect_ingredients) i WHERE i
  ILIKE '<name>')' for the array column). sem.drug_trial_ae_link's
  canonical_ingredient is the one column that IS already
  lower-cased by the view itself -- safe to compare with a plain
  lower-cased literal there, but that guarantee does not extend to the
  two raw columns above.
`.trim();

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

const TIER3_TOOL: Tool = {
  name: "emit_tier3_result",
  description:
    "Return the structured Tier 3 text-to-SQL result for the user's question.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["sql", "clarify", "no_match"] },
      sql: { type: "string" },
      explanation: { type: "string" },
      question: { type: "string" },
    },
    required: ["kind"],
  },
};

interface RawTier3ModelOutput {
  kind?: string;
  sql?: string;
  explanation?: string;
  question?: string;
}

function buildSystemPrompt(catalogText: string): string {
  return `You are a SQL generator for PharmaSentinel, a governed text-to-SQL
analytics assistant over de-identified FAERS adverse-event reports and
ClinicalTrials.gov data.

You may ONLY reference the sem.* views listed below -- never invent a
table or column, and never reference faers.*/ct.* raw tables directly
(raw-table access is a separate fallback tier you are not part of).

Available views (schema-qualified name and columns):
${catalogText}

${RELATIONSHIP_NOTES}

Call the emit_tier3_result tool exactly once with one of:
  {"kind": "sql", "sql": "<a single SELECT statement>", "explanation": "<1-2 sentences>"}
  {"kind": "clarify", "question": "<a clarifying question to ask the user>"}
  {"kind": "no_match"}

Use "no_match" whenever you cannot produce a valid single SELECT statement
grounded entirely in the views above.`;
}

/**
 * One forced tool-call round-trip against Claude, following the same
 * tool-use structured-output pattern as `lib/guardrails/classify.ts`
 * (the Anthropic SDK has no `messages.parse()`/zodOutputFormat helper).
 */
async function callModel(
  client: Anthropic,
  systemPrompt: string,
  userContent: string,
): Promise<RawTier3ModelOutput | null> {
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
    tools: [TIER3_TOOL],
    tool_choice: { type: "tool", name: TIER3_TOOL.name },
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  return toolUse ? (toolUse.input as RawTier3ModelOutput) : null;
}

/**
 * Generate SQL for a natural-language question against the Tier 2 (sem.*)
 * semantic layer.
 *
 * Order of operations:
 *   1. Check the verified-query cache (`verifiedQueries.ts`) for an exact
 *      normalized match; if found, validate it and return it WITHOUT
 *      calling the LLM.
 *   2. Otherwise call Claude, grounded on the live `sem.*` catalog
 *      (`semanticCatalog.ts`) and the FK/relationship notes above.
 *   3. Validate any returned SQL through `astValidator.ts`. On a validation
 *      failure, retry once with a repair prompt that includes the
 *      rejection reason; if that also fails, return `no_match` rather than
 *      surface broken SQL.
 *
 * Returns `no_match` whenever Tier 3 can't confidently produce a valid,
 * in-scope, allowlist-validated query -- the caller (see
 * `app/api/chat/route.ts`) should then try `tier4Fallback`.
 */
export async function generateTier3Sql(
  question: string,
  conversationHistory: ConversationTurn[],
): Promise<Tier3Result> {
  const catalog = await loadSemanticViewCatalog();
  const allowedTables = catalogTableNames(catalog);

  // 1. Verified-query cache short-circuit -- no LLM call on a hit.
  const verifiedMatch = findVerifiedMatch(question, SEED_VERIFIED_QUERIES);
  if (verifiedMatch) {
    const validated = tryValidate(verifiedMatch.sql, allowedTables);
    if (validated?.ok) {
      return {
        kind: "sql",
        sql: validated.sql,
        explanation: "Matched a pre-verified query.",
      };
    }
    // A verified-cache entry that no longer validates (e.g. a view was
    // renamed/dropped since it was written) is a data problem, not a
    // reason to serve unsafe SQL -- fall through to the LLM path below
    // instead of returning it as-is.
  }

  // 2. LLM generation, grounded on the live catalog.
  const client = getClient();
  const systemPrompt = buildSystemPrompt(formatCatalogForPrompt(catalog));

  const historyText = conversationHistory
    .map((turn) => `${turn.role}: ${turn.text}`)
    .join("\n");
  const userContent = historyText
    ? `Conversation so far:\n${historyText}\n\nNew question: ${question}`
    : question;

  const raw = await callModel(client, systemPrompt, userContent);
  if (!raw) {
    return { kind: "no_match" };
  }

  if (raw.kind === "clarify" && raw.question) {
    return { kind: "clarify", question: raw.question };
  }

  if (raw.kind === "sql" && raw.sql) {
    return validateWithRepair(
      client,
      systemPrompt,
      raw.sql,
      raw.explanation ?? "",
      allowedTables,
    );
  }

  return { kind: "no_match" };
}

function tryValidate(
  sql: string,
  allowedTables: string[],
): ValidateSqlResult | null {
  try {
    return validateSql(sql, { allowedTables });
  } catch {
    // Genuinely unparseable SQL -- treat the same as a validation failure.
    return null;
  }
}

/**
 * Validate `sql`; on failure, send the validator's rejection reason back to
 * the model for exactly ONE repair attempt. If the repaired SQL also fails
 * (or the model can't produce a usable repair), return `no_match` rather
 * than surface broken SQL to the caller.
 */
async function validateWithRepair(
  client: Anthropic,
  systemPrompt: string,
  sql: string,
  explanation: string,
  allowedTables: string[],
): Promise<Tier3Result> {
  const validation = tryValidate(sql, allowedTables);
  if (validation?.ok) {
    return { kind: "sql", sql: validation.sql, explanation };
  }

  const reason = validation?.ok === false ? validation.reason : "SQL could not be parsed.";
  const repairPrompt = `The SQL you returned failed validation: ${reason}

Original SQL:
${sql}

Call emit_tier3_result again with a corrected result, still grounded ONLY
in the views listed in the system prompt.`;

  const repaired = await callModel(client, systemPrompt, repairPrompt);
  if (!repaired) {
    return { kind: "no_match" };
  }

  if (repaired.kind === "clarify" && repaired.question) {
    return { kind: "clarify", question: repaired.question };
  }

  if (repaired.kind === "sql" && repaired.sql) {
    const repairedValidation = tryValidate(repaired.sql, allowedTables);
    if (repairedValidation?.ok) {
      return {
        kind: "sql",
        sql: repairedValidation.sql,
        explanation: repaired.explanation ?? explanation,
      };
    }
  }

  return { kind: "no_match" };
}
