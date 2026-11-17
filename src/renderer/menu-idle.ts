// [LAW:no-shared-mutable-globals] Each session's idle period, and when its
// menus close on their own (brandon-menus-sjhy.my3): the renderer's state, on
// its ticks.
//
// A session's record is three facts, each written by what it says: when its
// idle period began (a click landing, or a draw that showed a menu where the
// last showed none), the timeout its settings resolve to, and whether its last
// draw showed a menu. When the menus close is derived from them: a timeout
// after the period began, while a menu is shown. Records come only from draws,
// and a retire ends one.

import { closesAt } from "../config/menu-timeout.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import type { MenuIdleStats } from "../daemon/foundations/stats-snapshot.js";
import {
  earliestOf,
  type Instant,
  type Readings,
  type Tick,
} from "../utils/instant.js";

interface Idle {
  since: Tick;
  timeoutS: number;
  shown: boolean;
}

// An idle period that ran out: how long the session was idle by then, and the
// timeout it ran, which the close's line says.
export interface IdleSpan {
  readonly idleS: number;
  readonly timeoutS: number;
}

export class MenuIdle {
  private readonly sessions = new Map<SessionId, Idle>();

  // What the session's draw at `tick` showed: whether a menu row, and the
  // timeout its settings resolve to. A menu shown where the last draw showed
  // none begins its idle period here, so one nobody clicked open (a group
  // open by default, a reload) is not closed by a click from long ago.
  drew(sessionId: SessionId, tick: Tick, shown: boolean, timeoutS: number) {
    const idle = this.sessions.get(sessionId);
    if (idle === undefined) {
      this.sessions.set(sessionId, { since: tick, timeoutS, shown });
      return;
    }
    if (shown && !idle.shown) idle.since = tick;
    idle.shown = shown;
    idle.timeoutS = timeoutS;
  }

  // A click of the session landed: a new idle period begins. A session that
  // has not drawn has no menu to count down.
  clicked(sessionId: SessionId, tick: Tick): void {
    const idle = this.sessions.get(sessionId);
    if (idle !== undefined) idle.since = tick;
  }

  // When the idle period of the menus the session's last draw showed began,
  // on the wall the draw is made on, or null while it showed none: a menu
  // that appears now has only begun.
  // [LAW:one-source-of-truth] Derived from the period's tick, so the flash
  // the draw shows ends where the close lands however the wall has stepped.
  since(sessionId: SessionId, { at, tick }: Readings): Instant | null {
    const idle = this.sessions.get(sessionId);
    return idle?.shown === true
      ? ((at - (tick - idle.since)) as Instant)
      : null;
  }

  retire(sessionId: SessionId): void {
    this.sessions.delete(sessionId);
  }

  // The earliest tick a session's menus close at, or null when none shows a
  // menu.
  next(): Tick | null {
    return earliestOf(
      [...this.sessions.values()].map((idle) =>
        idle.shown ? closesAt(idle.since, idle.timeoutS) : null,
      ),
    );
  }

  // The sessions whose idle period has run out by `tick`, each taken as
  // closed: what its last draw showed no longer stands, and a new period
  // begins, so a close that fails is tried again a timeout later, never at
  // once, and a session that stops drawing is never closed again.
  due(
    tick: Tick,
  ): Array<{ readonly session: SessionId; readonly idle: IdleSpan }> {
    const due: Array<{ session: SessionId; idle: IdleSpan }> = [];
    for (const [session, idle] of this.sessions) {
      if (!idle.shown || closesAt(idle.since, idle.timeoutS) > tick) continue;
      due.push({
        session,
        idle: { idleS: tick - idle.since, timeoutS: idle.timeoutS },
      });
      idle.since = tick;
      idle.shown = false;
    }
    return due;
  }

  // The sessions whose period is kept, and those with a menu counting down.
  stats(): MenuIdleStats {
    let armed = 0;
    for (const idle of this.sessions.values()) if (idle.shown) armed++;
    return { sessions: this.sessions.size, armed };
  }
}
