// The Cohort Builder shares the Chat tab's `/api/chat` client rather than
// duplicating it — both tabs ultimately drive the same endpoint with a
// natural-language question, just composed differently (free text here vs.
// a structured form on this page). Re-exported from `chat/apiClient.ts`
// (owned by this same track) rather than `src/lib/` per the task's scope
// rules.
export { postChat, newSessionId, type ChatApiResponse } from "../chat/apiClient";
