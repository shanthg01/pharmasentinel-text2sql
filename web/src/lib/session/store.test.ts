import { beforeEach, describe, expect, it, vi } from "vitest";

// The store's Map is both a module-level binding AND cached on `globalThis`
// (see store.ts's module comment, mirroring lib/db/client.ts's pool
// caching). A dynamic re-import alone would still see the same module
// instance (and thus the same Map) within one test file, so each test must
// reset BOTH the module registry and the global before re-importing to get
// a genuinely fresh store.
function resetStore() {
  vi.resetModules();
  const globalForSessionStore = globalThis as unknown as {
    __pharmasentinelSessionStore?: Map<string, unknown>;
  };
  delete globalForSessionStore.__pharmasentinelSessionStore;
}

describe("session store", () => {
  beforeEach(() => {
    resetStore();
  });

  it("returns an empty array for a session with no history", async () => {
    const { getHistory } = await import("./store");
    expect(getHistory("unknown-session")).toEqual([]);
  });

  it("appends turns and returns them in insertion order", async () => {
    const { getHistory, appendTurn } = await import("./store");

    appendTurn("s1", { role: "user", text: "How many cases for aspirin?" });
    appendTurn("s1", { role: "assistant", text: "SELECT ... (tier3)" });
    appendTurn("s1", { role: "user", text: "What about last year?" });

    expect(getHistory("s1")).toEqual([
      { role: "user", text: "How many cases for aspirin?" },
      { role: "assistant", text: "SELECT ... (tier3)" },
      { role: "user", text: "What about last year?" },
    ]);
  });

  it("keeps sessions independent of each other", async () => {
    const { getHistory, appendTurn } = await import("./store");

    appendTurn("s1", { role: "user", text: "question in session 1" });
    appendTurn("s2", { role: "user", text: "question in session 2" });

    expect(getHistory("s1")).toEqual([
      { role: "user", text: "question in session 1" },
    ]);
    expect(getHistory("s2")).toEqual([
      { role: "user", text: "question in session 2" },
    ]);
  });

  it("trims history to the last 20 turns", async () => {
    const { getHistory, appendTurn } = await import("./store");

    for (let i = 0; i < 25; i++) {
      appendTurn("s1", { role: "user", text: `turn ${i}` });
    }

    const history = getHistory("s1");
    expect(history).toHaveLength(20);
    // The oldest 5 turns (0-4) should have been dropped; turn 5 is now the
    // oldest surviving turn and turn 24 the newest.
    expect(history[0]).toEqual({ role: "user", text: "turn 5" });
    expect(history[19]).toEqual({ role: "user", text: "turn 24" });
  });

  it("evicts the oldest session once the session-count cap is exceeded", async () => {
    const { getHistory, appendTurn } = await import("./store");

    // Fill the store to exactly the 500-session cap.
    for (let i = 0; i < 500; i++) {
      appendTurn(`session-${i}`, { role: "user", text: "hi" });
    }
    expect(getHistory("session-0")).toHaveLength(1);

    // One more distinct session should evict the oldest (session-0), since
    // it was never touched again after its own first append.
    appendTurn("session-500", { role: "user", text: "hi" });

    expect(getHistory("session-0")).toEqual([]);
    expect(getHistory("session-500")).toHaveLength(1);
    expect(getHistory("session-1")).toHaveLength(1);
  });

  it("touching an existing session moves it to the front of the eviction order", async () => {
    const { getHistory, appendTurn } = await import("./store");

    for (let i = 0; i < 500; i++) {
      appendTurn(`session-${i}`, { role: "user", text: "hi" });
    }
    // Re-touch session-0 so it's no longer the least-recently-touched entry.
    appendTurn("session-0", { role: "user", text: "hi again" });

    // The next new session should now evict session-1 (the new oldest),
    // not session-0.
    appendTurn("session-500", { role: "user", text: "hi" });

    expect(getHistory("session-0")).toHaveLength(2);
    expect(getHistory("session-1")).toEqual([]);
  });
});
