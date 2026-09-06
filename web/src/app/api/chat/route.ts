import { NextResponse } from "next/server";
import { runGuardrails } from "@/lib/guardrails";
import { generateTier3Sql } from "@/lib/text2sql/tier3";
import { tier4Fallback } from "@/lib/text2sql/tier4";
import { query, queryTier4 } from "@/lib/db/client";
import { appendTurn, getHistory } from "@/lib/session/store";
import { streamAnswer } from "@/lib/render/renderAnswer";

export interface ChatRequestBody {
  question: string;
  sessionId: string;
  /**
   * Opt-in flag (absent/false by default). Only the Chat tab ever sends
   * `stream: true`; every other caller of this route (cohort/auditor/
   * evaluation) omits it and gets byte-for-byte the same JSON response this
   * route has always returned -- see the "STREAMING WIRE FORMAT" doc below
   * for what changes when it's set.
   */
  stream?: boolean;
}

/**
 * ---------------------------------------------------------------------
 * STREAMING WIRE FORMAT (`stream: true`) -- contract shared verbatim with
 * `web/src/app/chat/apiClient.ts` (see the matching comment there). This is
 * the TODO below closed out: natural-language rendering of results, opt-in
 * via `stream: true` so the default (unset/false) response shape and code
 * path are completely unchanged from before this feature.
 *
 * When `stream: true`, POST returns a `Response` with
 * `Content-Type: text/plain; charset=utf-8` whose body is a
 * `ReadableStream<Uint8Array>` framed as exactly:
 *
 *   1. ONE metadata line: `JSON.stringify(metadata) + "\n"`, where
 *      `metadata` is `{ kind, category?, question?, sql?, rows? }` -- the
 *      same structured fields (kind/sql/rows) the non-streaming JSON body
 *      carries, so the client can still show the SQL/table. `message` is
 *      deliberately NOT duplicated into metadata -- it's exactly the text
 *      streamed in step 2 below.
 *   2. Zero or more further chunks of plain UTF-8 text: for a real tier3/
 *      tier4 success, the natural-language answer streamed token-by-token
 *      from `renderAnswer.ts`'s `streamAnswer()`; for reject/clarify/
 *      no_answer, the same message/question text as a single chunk (no
 *      separate code path -- see `streamResponse()`/`textOnceGenerator()`
 *      below).
 *
 * Chosen over SSE framing for simplicity: there's exactly one logical
 * "field" (running text) plus one small upfront header, so a bare
 * text/plain body with a JSON first line avoids `data:`/event-name
 * boilerplate. A plain `text/plain` reader (`response.body.getReader()`)
 * is sufficient on the client; no EventSource/SSE parser needed.
 * ---------------------------------------------------------------------
 */
interface ChatStreamMetadata {
  kind: "reject" | "clarify" | "no_answer" | "tier3" | "tier4";
  category?: string;
  question?: string;
  sql?: string;
  rows?: Record<string, unknown>[];
}

async function* textOnceGenerator(text: string): AsyncGenerator<string> {
  yield text;
}

function streamResponse(
  metadata: ChatStreamMetadata,
  textChunks: AsyncGenerator<string>,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify(metadata)}\n`));
      try {
        for await (const chunk of textChunks) {
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (err) {
        // The metadata (and any partial text already enqueued) has already
        // been sent -- log for visibility rather than throwing out of a
        // ReadableStream controller callback.
        console.error("Error while streaming chat answer:", err);
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

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

  const streamRequested = body.stream === true;

  const guardrailResult = await runGuardrails(question);
  if (guardrailResult.verdict !== "allow") {
    // Guardrail reject/clarify happens BEFORE the question is considered
    // "on topic" at all -- deliberately not recorded as conversation
    // history, so an off-topic aside doesn't get threaded into the prompt
    // for the user's next, on-topic question.
    if (streamRequested) {
      return streamResponse(
        { kind: guardrailResult.verdict, category: guardrailResult.category },
        textOnceGenerator(guardrailResult.message ?? ""),
      );
    }
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
    if (streamRequested) {
      return streamResponse(
        { kind: "clarify", question: tier3Result.question },
        textOnceGenerator(tier3Result.question),
      );
    }
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
      if (streamRequested) {
        return streamResponse(
          { kind: "no_answer" },
          textOnceGenerator(message),
        );
      }
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

  if (streamRequested) {
    return streamResponse(
      { kind, sql, rows },
      streamAnswer(question, kind, sql, rows),
    );
  }
  return NextResponse.json({ kind, sql, rows });
}
