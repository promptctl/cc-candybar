// [LAW:one-source-of-truth] Each session's menu idle period: when it began,
// whether the session's last draw drew a menu row, and the timeout its
// settings resolve to. The close falls due a timeout after the period began,
// while a menu is drawn (`closesAt`, src/config/menu-timeout.ts), and the
// renderer's wake declares it: no timer, so the close is a `due` turn like
// any other, ordered by the mailbox against the clicks around it.
// [LAW:no-ambient-temporal-coupling] Turns run one at a time, so the last
// draw applied is the newest whatever its instant reads.

import { closesAt } from "../config/menu-timeout.js";
import type { Instant } from "../utils/instant.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import type { MenuIdleStats } from "../daemon/foundations/stats-snapshot.js";

// What one draw drew of the session's menus: whether a menu row, and the
// timeout its settings resolve to.
export interface DrawnMenus {
  readonly shown: boolean;
  readonly timeoutS: number;
}

interface Idle {
  since: Instant;
  shown: boolean;
  timeoutS: number;
}

export class MenuIdle {
  private readonly sessions = new Map<SessionId, Idle>();

  // When the idle period of the menus the session's last draw drew began,
  // or null while it drew none: a menu that appears now has only begun.
  idleSince(sessionId: SessionId): Instant | null {
    const idle = this.sessions.get(sessionId);
    return idle?.shown === true ? idle.since : null;
  }

  // What a draw at `at` drew. A menu drawn where the last draw drew none
  // begins its idle period here, so one nobody clicked open (a group open by
  // default, a reload) is not closed by a click from long ago.
  drew(sessionId: SessionId, at: Instant, menus: DrawnMenus): void {
    const idle = this.record(sessionId, at);
    if (menus.shown && !idle.shown) idle.since = at;
    idle.shown = menus.shown;
    idle.timeoutS = menus.timeoutS;
  }

  // A click of the session landed at `at`: a new idle period begins.
  clicked(sessionId: SessionId, at: Instant): void {
    this.record(sessionId, at).since = at;
  }

  // The earliest close due, or null while no session draws a menu.
  next(): Instant | null {
    let next: Instant | null = null;
    for (const { since, shown, timeoutS } of this.sessions.values()) {
      const due = closesAt(since, timeoutS);
      if (shown && (next === null || due < next)) next = due;
    }
    return next;
  }

  // The sessions whose close is due by `at`, each with how long it was idle.
  due(at: Instant): ReadonlyArray<{
    readonly sessionId: SessionId;
    readonly idleS: number;
    readonly timeoutS: number;
  }> {
    return [...this.sessions].flatMap(([sessionId, idle]) =>
      idle.shown && closesAt(idle.since, idle.timeoutS) <= at
        ? [{ sessionId, idleS: at - idle.since, timeoutS: idle.timeoutS }]
        : [],
    );
  }

  // The session's close ran at `at`, or threw: what its last draw drew no
  // longer stands, so the next close waits for a draw that draws a menu
  // again and falls a timeout after it, never at once.
  shut(sessionId: SessionId, at: Instant): void {
    const idle = this.sessions.get(sessionId)!;
    idle.since = at;
    idle.shown = false;
  }

  retire(sessionId: SessionId): void {
    this.sessions.delete(sessionId);
  }

  stats(): MenuIdleStats {
    let armed = 0;
    for (const idle of this.sessions.values()) if (idle.shown) armed++;
    return { sessions: this.sessions.size, armed };
  }

  private record(sessionId: SessionId, at: Instant): Idle {
    let idle = this.sessions.get(sessionId);
    if (idle === undefined) {
      idle = { since: at, shown: false, timeoutS: 0 };
      this.sessions.set(sessionId, idle);
    }
    return idle;
  }
}
