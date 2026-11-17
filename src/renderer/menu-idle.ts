// [LAW:no-shared-mutable-globals] [LAW:no-ambient-temporal-coupling] The
// renderer's one owner of each session's menu idle period, and of when its
// menus close: `menuTimeout` seconds after it began (brandon-menus-sjhy.my3).
//
// A session's record is three facts — when its idle period began, the timeout
// its settings resolve to, whether its last frame drew a menu — and the close
// is DERIVED from them: due at the deadline while a menu is drawn, at no
// instant otherwise. A click and a draw each write their own fact, in their
// own turns, at those turns' instants, so neither has to arrive before the
// other for the close to fall where the record says. The renderer declares
// the earliest close it holds as its wake, and the `due` turn at that instant
// closes what is due as the turn finds the record: a click ahead of it in the
// mailbox moved the deadline, and closes nothing.

import { closesAt } from "../config/menu-timeout.js";
import type { Instant } from "../utils/instant.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import type { MenuIdleStats } from "../daemon/foundations/stats-snapshot.js";

// What a draw drew of a session's menus: whether a menu row, and the timeout
// its settings resolve to. The draw returns it; the turn hands it here.
export interface MenusDrawn {
  readonly shown: boolean;
  readonly timeoutS: number;
}

// A close as it falls due: when the idle period began, how long the session
// was idle by the turn's instant, and the timeout it ran, which the close's
// line says.
export interface IdleSpan {
  readonly session: SessionId;
  readonly idleS: number;
  readonly timeoutS: number;
}

interface Idle {
  since: Instant;
  timeoutS: number;
  shown: boolean;
  // The instant of the draw `shown` and `timeoutS` were read off: a draw for
  // an earlier instant (a request answered behind a frame) tells nothing.
  drawnAt: Instant;
}

export class MenuIdle {
  private readonly sessions = new Map<SessionId, Idle>();

  private record(sessionId: SessionId, at: Instant): Idle {
    const held = this.sessions.get(sessionId);
    if (held !== undefined) return held;
    const idle: Idle = { since: at, timeoutS: 0, shown: false, drawnAt: at };
    this.sessions.set(sessionId, idle);
    return idle;
  }

  // When the idle period of the menus the session's last draw drew began, as
  // a draw at that turn reads it: null while that draw drew none.
  idleSince(sessionId: SessionId): Instant | null {
    const idle = this.sessions.get(sessionId);
    return idle?.shown === true ? idle.since : null;
  }

  // What a draw at `at` drew. A menu newly drawn starts the idle period: one
  // that opened long after the last click counts from its first frame.
  drew(sessionId: SessionId, at: Instant, drawn: MenusDrawn): void {
    const idle = this.record(sessionId, at);
    if (at < idle.drawnAt) return;
    if (drawn.shown && !idle.shown && at > idle.since) idle.since = at;
    idle.shown = drawn.shown;
    idle.timeoutS = drawn.timeoutS;
    idle.drawnAt = at;
  }

  // A click of the session landed in the turn at `at`: its idle period
  // begins again.
  clicked(sessionId: SessionId, at: Instant): void {
    this.record(sessionId, at).since = at;
  }

  // [LAW:dataflow-not-control-flow] The earliest close any session's record
  // holds, or null for none: the renderer's wake reads it.
  next(): Instant | null {
    let soonest: Instant | null = null;
    for (const idle of this.sessions.values()) {
      if (!idle.shown) continue;
      const at = closesAt(idle.since, idle.timeoutS);
      if (soonest === null || at < soonest) soonest = at;
    }
    return soonest;
  }

  // Each session whose close is due by `at`, shut as it is handed out: its
  // idle period begins again and no menu is drawn, so whether its close went
  // ahead or threw, it falls due again only a timeout after a frame draws a
  // menu again, never at once.
  due(at: Instant): readonly IdleSpan[] {
    const spans: IdleSpan[] = [];
    for (const [session, idle] of this.sessions) {
      if (!idle.shown || closesAt(idle.since, idle.timeoutS) > at) continue;
      spans.push({ session, idleS: at - idle.since, timeoutS: idle.timeoutS });
      idle.since = at;
      idle.shown = false;
    }
    return spans;
  }

  // The session ended: its record goes with it.
  retire(sessionId: SessionId): void {
    this.sessions.delete(sessionId);
  }

  stats(): MenuIdleStats {
    let armed = 0;
    for (const idle of this.sessions.values()) if (idle.shown) armed++;
    return { sessions: this.sessions.size, armed };
  }
}
