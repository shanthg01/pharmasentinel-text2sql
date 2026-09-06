// Thin client for `POST /api/chat`, shared by the Chat page and the Cohort
// Builder (which composes a structured form into a single natural-language
// question and sends it through this same helper).
//
// Mirrors the response contract documented in `src/app/api/chat/route.ts`:
//   - guardrail reject/clarify: { kind: "reject" | "clarify", category?, message? }
//   - tier3 clarify:            { kind: "clarify", question }
//   - no usable query at all:   { kind: "no_answer", message }
//   - success:                  { kind: "tier3" | "tier4", sql, rows }
//
// That route is owned by a different track and may still be returning
// stubbed/placeholder content (e.g. tier4 always "no_answer" today) — this
// client and the UI built on it treat every one of the shapes above as a
// normal, renderable response rather than an error.
//
// `postChat` above is unchanged and untouched by streaming — it never sends
// `stream: true` and always gets back the plain JSON body described above.
//
// ---------------------------------------------------------------------
// STREAMING WIRE FORMAT (`stream: true`) -- contract shared verbatim with
// `src/app/api/chat/route.ts` (see the matching comment there, which is the
// authoritative copy — keep both in sync if this ever changes).
//
// When a request sends `stream: true`, the response body is a
// `ReadableStream` of UTF-8 bytes with `Content-Type: text/plain`, framed as:
//   1. ONE metadata line: `JSON.stringify(metadata) + "\n"`, where
//      `metadata` is `{ kind, category?, question?, sql?, rows? }`.
//   2. Zero or more further chunks of plain text: the natural-language
//      answer (streamed token-by-token for a tier3/tier4 success), or the
//      reject/clarify/no_answer message/question as a single chunk.
//
// `postChatStream` below reads the body via `response.body.getReader()`,
// buffers bytes until the first "\n" to recover `metadata`, then yields
// every byte after it (decoded incrementally) as `{ metadata, textDelta }`
// updates via an async generator — callers `for await` it to render the NL
// answer growing token-by-token while still having `metadata.sql`/`.rows`
// available as soon as the first chunk arrives.
// ---------------------------------------------------------------------

// Deliberately a closed set of literals (not `| string`) rather than a
// catch-all — a plain-`string` member on a shared discriminant defeats
// TypeScript's discriminated-union narrowing for every caller that
// switches on `kind` (e.g. alongside a `{ kind: "error"; ... }` client-side
// variant). If route.ts ever adds a new `kind`, add it here too.
export interface ChatApiResponse {
  kind: "reject" | "clarify" | "no_answer" | "tier3" | "tier4";
  category?: string;
  message?: string;
  /** Present on a tier3 clarify response instead of `message`. */
  question?: string;
  sql?: string;
  rows?: Array<Record<string, unknown>>;
}

interface ChatApiErrorBody {
  error: string;
}

/**
 * POSTs a question to `/api/chat` and returns the parsed JSON response.
 * Throws (with a human-readable message) on a network failure, a non-OK
 * HTTP status, or a `{ error }` body — callers should catch this and render
 * it as a distinct error state, separate from a guardrail rejection.
 */
export async function postChat(
  question: string,
  sessionId: string,
): Promise<ChatApiResponse> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, sessionId }),
  });

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(`The server returned an unreadable response (${response.status}).`);
  }

  if (!response.ok) {
    const errorMessage =
      data && typeof data === "object" && "error" in data
        ? String((data as ChatApiErrorBody).error)
        : `Request failed with status ${response.status}.`;
    throw new Error(errorMessage);
  }

  if (data && typeof data === "object" && "error" in data) {
    throw new Error(String((data as ChatApiErrorBody).error));
  }

  return data as ChatApiResponse;
}

/**
 * A best-effort session id for grouping a run of questions together.
 * `route.ts` doesn't yet persist/load history by session (see its TODOs),
 * so this is forward-looking — sending a stable id per page load costs
 * nothing now and means multi-turn grounding works with zero UI changes
 * once that lands server-side.
 */
export function newSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Metadata carried in the streamed response's first line -- see the
 * STREAMING WIRE FORMAT comment at the top of this file. */
export interface ChatStreamMetadata {
  kind: "reject" | "clarify" | "no_answer" | "tier3" | "tier4";
  category?: string;
  question?: string;
  sql?: string;
  rows?: Array<Record<string, unknown>>;
}

export interface ChatStreamUpdate {
  /** Present on every update (parsed once, from the stream's first line). */
  metadata: ChatStreamMetadata;
  /** The text received in this update only (may be "" on the very first
   * update, which fires as soon as `metadata` is available). */
  textDelta: string;
  /** The full natural-language text accumulated across every update so far
   * -- convenient for callers that just want to re-render the growing
   * answer rather than manage concatenation themselves. */
  textSoFar: string;
}

/**
 * Streaming counterpart to `postChat`: sends `stream: true` and yields one
 * `ChatStreamUpdate` per chunk of the response as it arrives, via
 * `response.body.getReader()`, so a caller can render the natural-language
 * answer growing token-by-token while still having `metadata.sql`/`.rows`
 * available (from the very first yielded update).
 *
 * Throws (with a human-readable message) on a network failure, a non-OK
 * HTTP status, or a stream that ends before a metadata line ever completed
 * — same error-handling posture as `postChat`.
 */
export async function* postChatStream(
  question: string,
  sessionId: string,
): AsyncGenerator<ChatStreamUpdate> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, sessionId, stream: true }),
  });

  if (!response.ok || !response.body) {
    let errorMessage = `Request failed with status ${response.status}.`;
    try {
      const data: unknown = await response.json();
      if (data && typeof data === "object" && "error" in data) {
        errorMessage = String((data as ChatApiErrorBody).error);
      }
    } catch {
      // Body wasn't JSON (or was empty/absent) -- keep the generic message.
    }
    throw new Error(errorMessage);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let metadata: ChatStreamMetadata | null = null;
  let textSoFar = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    if (!metadata) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        // Still waiting on the rest of the metadata line.
        continue;
      }
      const headerLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      metadata = JSON.parse(headerLine) as ChatStreamMetadata;
      yield { metadata, textDelta: "", textSoFar };
    }

    if (buffer.length > 0) {
      textSoFar += buffer;
      yield { metadata, textDelta: buffer, textSoFar };
      buffer = "";
    }
  }

  if (!metadata) {
    throw new Error(
      "The server's streamed response ended before its metadata header completed.",
    );
  }
}
