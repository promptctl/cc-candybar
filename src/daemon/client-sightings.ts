// Which client each session's bar was last drawn by, and when — what
// `cc-candybar doctor` reads (through daemon-stats) to judge the clients the
// bar actually runs, since the command itself is no statusline client.
//
// [LAW:no-ambient-temporal-coupling] Held in memory by this daemon process,
// keyed by session and the client's role, REPLACED by every render: a
// session's next render after a rebuild shows its new client at once, and a
// session that stopped rendering only ages. The role is in the key because one
// session's bar can be drawn by two clients at once — Claude Code's statusline
// and a `cc-candybar frames` display — and the one rendering last must not
// hide the other from the check. Native, the Node fallback and a client too
// old to report are one role, the statusline, so a rebuild replaces it. SessionState is not this record — it is persisted, reloaded on
// start and never pruned, so a session an older daemon recorded would answer
// for a client nothing runs any more.

import type { ClientHint } from "../client-hint.js";
import type { Instant } from "../utils/instant.js";

// The newest sightings kept; a daemon serves a handful of sessions at once.
export const SIGHTINGS_KEPT = 64;

// `client` null: the render's client did not report what it is.
export interface ClientSighting {
  readonly client: ClientHint | null;
  // Seconds since the session's last render.
  readonly ago: number;
}

// [LAW:single-enforcer] The render path is the one writer (`see`, at the
// instant it serves a render); the doctor the one reader — daemon-stats for
// the CLI (`list`), the click for its own session (`ofSession`).
export class ClientSightings {
  private readonly seen = new Map<
    string,
    {
      readonly sessionId: string;
      readonly client: ClientHint | null;
      readonly at: Instant;
    }
  >();

  see(sessionId: string, client: ClientHint | undefined, at: Instant): void {
    // JSON, so no session id can spell another sighting's key.
    const role = client?.kind === "frames" ? "frames" : "statusline";
    const key = JSON.stringify([sessionId, role]);
    // Re-inserted, so the map's order is the order of last renders and the
    // first key is the sighting longest without one.
    this.seen.delete(key);
    this.seen.set(key, { sessionId, client: client ?? null, at });
    if (this.seen.size > SIGHTINGS_KEPT) {
      this.seen.delete(this.seen.keys().next().value!);
    }
  }

  list(now: Instant): readonly ClientSighting[] {
    return [...this.seen.values()].map(({ client, at }) => ({
      client,
      ago: now - at,
    }));
  }

  // The latest client in each role that drew one session's bar — none when
  // this process has served it no render (a daemon restarted under a bar
  // already on screen).
  ofSession(sessionId: string): ReadonlyArray<ClientHint | null> {
    return [...this.seen.values()]
      .filter((s) => s.sessionId === sessionId)
      .map((s) => s.client);
  }
}
