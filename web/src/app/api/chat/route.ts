import { NextResponse } from "next/server";
import { runGuardrails } from "@/lib/guardrails";
import { generateTier3Sql } from "@/lib/text2sql/tier3";
import { tier4Fallback } from "@/lib/text2sql/tier4";
import { query, queryTier4 } from "@/lib/db/client";
import { appendTurn, getHistory } from "@/lib/session/store";

export interface ChatRequestBody {
  question: string;
  sessionId: string;
}

// TODO: this endpoint is a plain synchronous request/response for this
// pass. Once natural-language rendering of results is built, switch to a
// streamed response (the Anthropic SDK's `.stream()` API) so token-by-token
// output can be shown while the underlying query runs.

/**
 * Append this turn's `{user question, assistant summary}` pair to
 * `sessionId`'s history, a no-op when there's no valid session to key on.
 *
 * What gets stored as the "assistant" side is deliberately a short summary
 * of the OUTCOME (generated SQL, or the clarify/no_answer message) rather
 * than the full response payload (e.g. row results) -- that's the compact,
 * faithful anchor a follow-up question needs ("what about last year?"
 * grounds against "we just ran this SQL" / "we just asked you to clarify
 * X"), and it keeps what gets threaded into `tier3.ts`'s prompt on the next
 * turn from ballooning with query result data that was never part of the
 * conversation itself.
 *
 * The user's question is recorded here too (not earlier, before Tier 3/4
 * ran) so it isn't also duplicated into that same call's own
 * conversationHistory -- `generateTier3Sql` already appends "New question:
 * <question>" itself; history should hold only turns from BEFORE the
 * current call.
 */
function recordTurn(
  sessionId: string | null,
  question: string,
  assistantSummary: string,
): void {
  if (!sessionId) {
    return;
  }
  appendTurn(sessionId, { role: "user", text: question });
  appendTurn(sessionId, { role: "assistant", text: assistantSummary });
}

/**
 * Orchestration seam: guardrails -> Tier 3 -> Tier 4 fallback -> execute.
 *
 * POST body: `{ question: string, sessionId: string }`
 * Response shapes:
 *   - guardrail reject/clarify: `{ kind: "reject" | "clarify", category?, message? }`
 *   - tier3 clarify:            `{ kind: "clarify", question }`
 *   - no usable query at all:   `{ kind: "no_answer", message }`
 *   - success:                  `{ kind: "tier3" | "tier4", sql, rows }`
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as Partial<ChatRequestBody>;
  const question = body.question?.trim();

  if (!question) {
    return NextResponse.json(
      { error: "Missing required field: question" },
      { status: 400 },
    );
  }

  // A missing/blank sessionId must NOT be used as a store key as-is: every
  // such request would collide onto the same shared history bucket (both
  // `undefined` and `""` are perfectly valid, distinct Map keys otherwise).
  // Treat that case as "no session" -- history is simply skipped for this
  // request (never loaded, never appended to) rather than pooled with
  // every other caller that also failed to send one.
  const sessionId =
    typeof body.sessionId === "string" && body.sessionId.trim().length > 0
      ? body.sessionId
      : null;

  const guardrailResult = await runGuardrails(question);
  if (guardrailResult.verdict !== "allow") {
    // Guardrail reject/clarify happens BEFORE the question is considered
    // "on topic" at all -- deliberately not recorded as conversation
    // history, so an off-topic aside doesn't get threaded into the prompt
    // for the user's next, on-topic question.
    return NextResponse.json({
      kind: guardrailResult.verdict,
      category: guardrailResult.category,
      message: guardrailResult.message,
    });
  }

  const history = sessionId ? getHistory(sessionId) : [];
  const tier3Result = await generateTier3Sql(question, history);

  if (tier3Result.kind === "clarify") {
    recordTurn(
      sessionId,
      question,
      `Asked for clarification: ${tier3Result.question}`,
    );
    return NextResponse.json({
      kind: "clarify",
      question: tier3Result.question,
    });
  }

  let sql: string;
  let kind: "tier3" | "tier4";

  if (tier3Result.kind === "sql") {
    sql = tier3Result.sql;
    kind = "tier3";
  } else {
    const tier4Result = await tier4Fallback(question);
    if (tier4Result.kind === "no_answer") {
      const message = "I couldn't find a way to answer that from the available data.";
      recordTurn(sessionId, question, `No answer available: ${message}`);
      return NextResponse.json({ kind: "no_answer", message });
    }
    sql = tier4Result.sql;
    kind = "tier4";
  }

  // Tier 4 SQL targets raw faers.*/ct.* tables, which the Tier 1-3
  // app_runtime role (used by query()) has no grant to read -- it must
  // execute through queryTier4()'s app_runtime_tier4 connection instead.
  const rows = kind === "tier4" ? await queryTier4(sql) : await query(sql);
  recordTurn(sessionId, question, `Generated ${kind} SQL: ${sql}`);
  return NextResponse.json({ kind, sql, rows });
}
