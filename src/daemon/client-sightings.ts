// Which client each session's bar was last drawn by, and when — what
// `cc-candybar doctor` reads (through daemon-stats) to judge the clients the
// bar actually runs, since the command itself is no statusline client.
//
// [LAW:no-ambient-temporal-coupling] Held in memory by this daemon process,
// keyed by session, REPLACED by every render: a session's next render after a
// rebuild shows its new client at once, and a session that stopped rendering
// only ages. SessionState is not this record — it is persisted, reloaded on
// start and never pruned, so a session an older daemon recorded would answer
// for a client nothing runs any more.

import type { ClientHint } from "../client-hint.js";
import type { Instant } from "../utils/instant.js";

// The newest sessions kept; a daemon serves a handful at once.
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
  private readonly bySession = new Map<
    string,
    { readonly client: ClientHint | null; readonly at: Instant }
  >();

  see(sessionId: string, client: ClientHint | undefined, at: Instant): void {
    // Re-inserted, so the map's order is the order of last renders and the
    // first key is the session longest without one.
    this.bySession.delete(sessionId);
    this.bySession.set(sessionId, { client: client ?? null, at });
    if (this.bySession.size > SIGHTINGS_KEPT) {
      this.bySession.delete(this.bySession.keys().next().value!);
    }
  }

  list(now: Instant): readonly ClientSighting[] {
    return [...this.bySession.values()].map(({ client, at }) => ({
      client,
      ago: now - at,
    }));
  }

  // One session's latest, or none when this process has served it no render
  // (a daemon restarted under a bar already on screen).
  ofSession(sessionId: string, now: Instant): readonly ClientSighting[] {
    const seen = this.bySession.get(sessionId);
    return seen === undefined
      ? []
      : [{ client: seen.client, ago: now - seen.at }];
  }
}
