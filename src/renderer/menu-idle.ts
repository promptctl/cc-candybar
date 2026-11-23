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
import type { MenuIdleStats } from "../renderer-interface/renderer-stats.js";
import {
  earliestOf,
  type Instant,
  type Readings,
  type Tick,
} from "../utils/instant.js";

export interface Idle {
  readonly since: Tick;
  readonly timeoutS: number;
  readonly shown: boolean;
}

export interface DrawnMenu {
  readonly tick: Tick;
  readonly shown: boolean;
  readonly timeoutS: number;
}

interface IdleRecords {
  get(session: SessionId): Idle | undefined;
  set(session: SessionId, idle: Idle): void;
  delete(session: SessionId): void;
  entries(): Iterable<readonly [SessionId, Idle]>;
}

// [LAW:no-ambient-temporal-coupling] An older draw cannot undo a click or
// reopen an idle period that already expired while its delivery was pending.
export function idleAfterDraw(prior: Idle | undefined, menu: DrawnMenu): Idle {
  const { tick, shown, timeoutS } = menu;
  if (prior === undefined) return { since: tick, shown, timeoutS };
  if (tick < prior.since) return prior;
  const since = shown && !prior.shown ? tick : prior.since;
  return { since, shown, timeoutS };
}

// An idle period that ran out: how long the session was idle by then, and the
// timeout it ran, which the close's line says.
export interface IdleSpan {
  readonly idleS: number;
  readonly timeoutS: number;
}

export class MenuIdle {
  constructor(private readonly sessions: IdleRecords = new Map()) {}

  // What the session's draw at `tick` showed: whether a menu row, and the
  // timeout its settings resolve to. A menu shown where the last draw showed
  // none begins its idle period here, so one nobody clicked open (a group
  // open by default, a reload) is not closed by a click from long ago.
  drew(sessionId: SessionId, tick: Tick, shown: boolean, timeoutS: number) {
    this.sessions.set(
      sessionId,
      idleAfterDraw(this.sessions.get(sessionId), { tick, shown, timeoutS }),
    );
  }

  // A click of the session landed: a new idle period begins. A session that
  // has not drawn has no menu to count down.
  clicked(sessionId: SessionId, tick: Tick): void {
    const idle = this.sessions.get(sessionId);
    if (idle !== undefined)
      this.sessions.set(sessionId, { ...idle, since: tick });
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
  next(busy?: ReadonlySet<SessionId>): Tick | null {
    return earliestOf(
      [...this.sessions.entries()].map(([session, idle]) =>
        this.expiryOf(session, idle, busy),
      ),
    );
  }

  // [LAW:single-enforcer] A pending click can restart the idle period. Until
  // it lands, the renderer neither takes nor schedules that session's close.
  private expiryOf(
    session: SessionId,
    idle: Idle,
    busy?: ReadonlySet<SessionId>,
  ): Tick | null {
    return idle.shown && !busy?.has(session)
      ? closesAt(idle.since, idle.timeoutS)
      : null;
  }

  // The sessions whose idle period has run out by `tick`, each taken as
  // closed: what its last draw showed no longer stands, and a new period
  // begins, so a close that fails is tried again a timeout later, never at
  // once, and a session that stops drawing is never closed again.
  due(
    tick: Tick,
    busy?: ReadonlySet<SessionId>,
  ): Array<{ readonly session: SessionId; readonly idle: IdleSpan }> {
    const due: Array<{ session: SessionId; idle: IdleSpan }> = [];
    for (const [session, idle] of this.sessions.entries()) {
      const expiry = this.expiryOf(session, idle, busy);
      if (expiry === null || expiry > tick) continue;
      due.push({
        session,
        idle: { idleS: tick - idle.since, timeoutS: idle.timeoutS },
      });
      this.sessions.set(session, { ...idle, since: tick, shown: false });
    }
    return due;
  }

  // The sessions whose period is kept, and those with a menu counting down.
  stats(): MenuIdleStats {
    let sessions = 0;
    let armed = 0;
    for (const [, idle] of this.sessions.entries()) {
      sessions++;
      if (idle.shown) armed++;
    }
    return { sessions, armed };
  }
}
