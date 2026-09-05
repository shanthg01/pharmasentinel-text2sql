/**
 * In-memory conversation-history store, keyed by `sessionId`.
 *
 * Why in-memory (not Postgres/Redis) for this pass:
 *
 * The app's two Postgres roles (`app_runtime` / `app_runtime_tier4`, see
 * `db/ddl/005_roles.sql`) are deliberately SELECT-only -- that's this
 * project's data-governance stance: the app's DB connections never get
 * write access, full stop. Persisting session history to Postgres would
 * mean either punching a write-grant hole into that role model (for a
 * single, low-stakes, ephemeral-by-nature piece of state) or standing up a
 * third role/connection just for this -- both bigger changes than this
 * pass's scope. So session history deliberately lives outside the DB
 * write boundary entirely, in the Node process's own memory, the same way
 * `lib/db/client.ts` caches its `pg.Pool` singletons: a module-level value
 * stashed on `globalThis` so Next.js dev-mode hot-reload (which can
 * re-evaluate this module many times) doesn't wipe/duplicate the store on
 * every reload.
 *
 * Real limitations this creates (documented, not a silent gap):
 *   - Does NOT survive a server restart -- history is lost on redeploy/crash.
 *   - Does NOT work across multiple server instances/processes -- a request
 *     load-balanced to a different instance than a prior turn in the same
 *     session sees an empty history for that instance.
 * A real multi-instance deployment needs Redis (shared, fast, TTL-capable)
 * or a dedicated writable-role Postgres table (auditable, transactional) --
 * either is the right follow-up once this ships past a single-instance dev/
 * demo deployment.
 */

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Max turns retained per session. Bounds prompt size/cost (every stored
 * turn gets serialized into the Tier 3 prompt in `tier3.ts`) -- multi-turn
 * follow-ups in practice only ever need to look back a few turns (e.g.
 * "what about last year?" anchors to the immediately preceding question),
 * so keeping the last 20 turns (10 user/assistant exchanges) comfortably
 * covers realistic follow-up chains without letting a long chat session's
 * prompt grow unbounded.
 */
const MAX_TURNS_PER_SESSION = 20;

/**
 * Max distinct sessions tracked at once. A long-running dev server that
 * never restarts would otherwise accumulate one Map entry per sessionId
 * forever (each browser tab/page-load mints a fresh one via
 * `newSessionId()`), which is unbounded memory growth. 500 is a generous
 * cap for a single-instance dev/demo deployment; past it we evict the
 * least-recently-touched session to make room for a new one, simple
 * LRU-ish behavior rather than a real LRU structure.
 */
const MAX_SESSIONS = 500;

/**
 * Map iteration order in JS is insertion order, and re-`set`-ing an
 * existing key moves it to the end -- so touching a session (via
 * `appendTurn` or by creating it fresh in `getHistory`) and re-inserting
 * it keeps this map ordered oldest-touched-first, letting eviction just
 * delete `.keys().next().value` without a separate LRU data structure.
 */
type SessionMap = Map<string, ConversationTurn[]>;

const globalForSessionStore = globalThis as unknown as {
  __pharmasentinelSessionStore?: SessionMap;
};

const store: SessionMap =
  globalForSessionStore.__pharmasentinelSessionStore ?? new Map();
if (process.env.NODE_ENV !== "production") {
  globalForSessionStore.__pharmasentinelSessionStore = store;
}

/** Move `sessionId` to the "most recently touched" end of the map. */
function touch(sessionId: string, turns: ConversationTurn[]): void {
  store.delete(sessionId);
  store.set(sessionId, turns);
}

/**
 * Return the stored conversation history for `sessionId`, oldest turn
 * first. Returns an empty array (never creates or touches a store entry)
 * for a session that has no history yet.
 */
export function getHistory(sessionId: string): ConversationTurn[] {
  return store.get(sessionId) ?? [];
}

/**
 * Append one turn to `sessionId`'s history, trimming to the last
 * `MAX_TURNS_PER_SESSION` turns and evicting the oldest tracked session if
 * this call would create a new session past `MAX_SESSIONS`.
 */
export function appendTurn(sessionId: string, turn: ConversationTurn): void {
  const existing = store.get(sessionId);

  if (!existing && store.size >= MAX_SESSIONS) {
    const oldestKey = store.keys().next().value;
    if (oldestKey !== undefined) {
      store.delete(oldestKey);
    }
  }

  const turns = [...(existing ?? []), turn].slice(-MAX_TURNS_PER_SESSION);
  touch(sessionId, turns);
}
