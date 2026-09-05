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
