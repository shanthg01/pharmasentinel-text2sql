import { NextResponse } from "next/server";
import { runGuardrails } from "@/lib/guardrails";
import { generateTier3Sql } from "@/lib/text2sql/tier3";
import { tier4Fallback } from "@/lib/text2sql/tier4";
import { query, queryTier4 } from "@/lib/db/client";

export interface ChatRequestBody {
  question: string;
  sessionId: string;
}

// TODO: this endpoint is a plain synchronous request/response for this
// pass. Once natural-language rendering of results is built, switch to a
// streamed response (the Anthropic SDK's `.stream()` API) so token-by-token
// output can be shown while the underlying query runs.

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

  const guardrailResult = await runGuardrails(question);
  if (guardrailResult.verdict !== "allow") {
    return NextResponse.json({
      kind: guardrailResult.verdict,
      category: guardrailResult.category,
      message: guardrailResult.message,
    });
  }

  // TODO: conversation history is not yet persisted/loaded per sessionId —
  // wire this up to real session storage (keyed by body.sessionId). Empty
  // history for now, so multi-turn follow-ups aren't grounded yet.
  const tier3Result = await generateTier3Sql(question, []);

  if (tier3Result.kind === "clarify") {
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
      return NextResponse.json({
        kind: "no_answer",
        message: "I couldn't find a way to answer that from the available data.",
      });
    }
    sql = tier4Result.sql;
    kind = "tier4";
  }

  // Tier 4 SQL targets raw faers.*/ct.* tables, which the Tier 1-3
  // app_runtime role (used by query()) has no grant to read -- it must
  // execute through queryTier4()'s app_runtime_tier4 connection instead.
  const rows = kind === "tier4" ? await queryTier4(sql) : await query(sql);
  return NextResponse.json({ kind, sql, rows });
}
