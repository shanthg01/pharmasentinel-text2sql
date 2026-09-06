import Anthropic from "@anthropic-ai/sdk";

/** Model used to render the natural-language answer. Override via
 * ANTHROPIC_MODEL. Matches the pattern in `lib/guardrails/classify.ts` and
 * `lib/text2sql/tier3.ts`. */
export const RENDER_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

/** Never send more than this many rows into the render prompt -- a large
 * result set is summarized as "first N rows + a total row count" instead of
 * serialized in full, so prompt size stays bounded regardless of how many
 * rows the query actually returned. */
const MAX_ROWS_IN_PROMPT = 20;

/**
 * Columns that carry FDA regulatory seriousness flags (see
 * `db/ddl/004_semantic_views.sql`, sem.faers_case_summary and the
 * "*** SEVERITY PROXY WARNING ***" on sem.drug_trial_ae_link). FAERS has no
 * CTCAE numeric grade field -- these booleans are only ever a documented
 * PROXY for adverse event severity, never a "Grade". When any of these
 * columns appear in the rendered rows, the system prompt below instructs
 * the model to reuse that exact framing rather than invent its own wording.
 */
const SERIOUSNESS_COLUMNS = [
  "serious",
  "seriousnessdeath",
  "seriousnesshospitalization",
  "seriousnesslifethreatening",
  "seriousnessdisabling",
];

const SERIOUSNESS_CAVEAT =
  'These rows include FDA regulatory seriousness criteria (e.g. "serious", ' +
  '"seriousnessdeath", "seriousnesshospitalization", ' +
  '"seriousnesslifethreatening", "seriousnessdisabling"). FAERS has no ' +
  "CTCAE (Common Terminology Criteria for Adverse Events) numeric grade " +
  "field -- these flags are a documented PROXY for adverse event severity, " +
  'not a clinical severity scale. Describe them as "FDA seriousness ' +
  'criteria", and NEVER as an AE "Grade" (e.g. never say "Grade 3/4").';

const SYSTEM_PROMPT = `You are the answer-rendering step of PharmaSentinel, a
governed text-to-SQL analytics assistant over de-identified FAERS
adverse-event reports and ClinicalTrials.gov data. You are given the user's
question, the SQL that was executed, and the rows it returned (possibly
truncated with a note of the true row count). Write a short, plain-English
answer (a few sentences at most) that describes ONLY what is in the given
rows.

Hard rules:
- Never add outside knowledge, clinical judgment, or claims not directly
  supported by the rows shown to you.
- If the rows were truncated, you may mention that more rows exist, but
  compute any count/total from the stated true row count, not from counting
  the truncated sample.
- If the result set is empty, say so plainly -- do not speculate about why.
- Do not repeat the raw SQL back verbatim; the caller already displays it
  separately.
- Be concise: a short paragraph, not a report.`;

function hasSeriousnessColumn(rows: Record<string, unknown>[]): boolean {
  if (rows.length === 0) {
    return false;
  }
  const columns = new Set(Object.keys(rows[0]));
  return SERIOUSNESS_COLUMNS.some((column) => columns.has(column));
}

/**
 * Renders a bounded, prompt-safe representation of `rows`: the first
 * `MAX_ROWS_IN_PROMPT` rows as JSON, plus an explicit note of the real row
 * count when rows were truncated. Never serializes an unbounded result set.
 */
function summarizeRowsForPrompt(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) {
    return "The query returned 0 rows.";
  }
  const truncated = rows.slice(0, MAX_ROWS_IN_PROMPT);
  const omitted = rows.length - truncated.length;
  const rowsJson = JSON.stringify(truncated, null, 2);
  return omitted > 0
    ? `Showing the first ${truncated.length} of ${rows.length} total rows:\n${rowsJson}\n\n(${omitted} further row(s) not shown here, but the true total row count is ${rows.length}.)`
    : `All ${rows.length} row(s):\n${rowsJson}`;
}

function buildUserContent(
  question: string,
  kind: "tier3" | "tier4",
  sql: string,
  rows: Record<string, unknown>[],
): string {
  const caveat = hasSeriousnessColumn(rows) ? `\n\n${SERIOUSNESS_CAVEAT}` : "";
  return `Question: ${question}

Query tier: ${kind}

SQL executed:
${sql}

Results:
${summarizeRowsForPrompt(rows)}${caveat}`;
}

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

/**
 * Streams a short natural-language answer describing `rows` (the result of
 * running `sql` for `question`), yielding text chunks as they arrive from
 * the model.
 *
 * Uses the Anthropic SDK's `client.messages.stream()` (verified against the
 * installed `@anthropic-ai/sdk` version's `MessageStream` class rather than
 * assumed): the returned `MessageStream` is itself `AsyncIterable` over raw
 * `content_block_delta` events, so this generator just filters those down to
 * `text_delta` chunks.
 */
export async function* streamAnswer(
  question: string,
  kind: "tier3" | "tier4",
  sql: string,
  rows: Record<string, unknown>[],
): AsyncGenerator<string> {
  const client = getClient();
  const stream = client.messages.stream({
    model: RENDER_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      { role: "user", content: buildUserContent(question, kind, sql, rows) },
    ],
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}
