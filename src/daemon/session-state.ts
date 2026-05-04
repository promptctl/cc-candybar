// [LAW:one-type-per-behavior] One generic store for all per-session state.
// Adding a new per-session value is just picking a string key — no new class,
// no DI wiring, no cache invalidation.

export interface SessionStateReader {
  get(sessionId: string, key: string): string | null;
}

export class SessionState implements SessionStateReader {
  private sessions = new Map<string, Map<string, string>>();

  get(sessionId: string, key: string): string | null {
    return this.sessions.get(sessionId)?.get(key) ?? null;
  }

  set(sessionId: string, key: string, value: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Map());
    }
    this.sessions.get(sessionId)!.set(key, value);
  }

  clear(sessionId: string, key: string): void {
    this.sessions.get(sessionId)?.delete(key);
  }

  // [LAW:one-source-of-truth] Drop state for sessions that no longer exist.
  prune(activeSessionIds: Set<string>): void {
    for (const id of this.sessions.keys()) {
      if (!activeSessionIds.has(id)) this.sessions.delete(id);
    }
  }
}
