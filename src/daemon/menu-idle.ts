// [LAW:no-shared-mutable-globals] [LAW:no-ambient-temporal-coupling] The
// daemon's one owner of each session's idle clock, and of the timer that closes
// its menus once the clock has run `menuTimeout` seconds (brandon-menus-sjhy.my3).
//
// A session's record is three facts — when its idle period began, the timeout
// its settings resolve to, whether its last frame drew a menu — and the timer
// is DERIVED from them by `settle`: armed at the deadline while a menu is
// drawn, absent otherwise, moved only when the deadline moves. A click and a
// render each write their own fact and settle, so neither has to arrive before
// the other for the close to land where the record says.

import { closesAt } from "../config/menu-timeout.js";
import type { Instant } from "../utils/instant.js";
import type { IdleClose } from "./verbs/index.js";

interface Idle {
  since: Instant;
  timeoutS: number;
  shown: boolean;
  timer: { readonly at: Instant; readonly handle: NodeJS.Timeout } | null;
}

export interface MenuIdleStats {
  readonly sessions: number;
  readonly armed: number;
}

export interface MenuIdleDeps {
  // The instant now, on the clock renders are drawn by.
  readonly now: () => Instant;
  // Close the session's menus: the journaled write a ✕ makes
  // (`closeIdleMenus`, src/daemon/verbs/index.ts).
  readonly close: (sessionId: string, idle: IdleClose) => void;
  // [LAW:no-silent-failure] A close that threw: a timer has no caller to
  // throw to, and an uncaught throw would end the daemon.
  readonly failed: (sessionId: string, error: unknown) => void;
}

// The sessions whose clocks are kept, as many as the daemon keeps effects for;
// the least recently touched goes first, and its timer with it.
const MAX_SESSIONS = 256;

export class MenuIdle {
  private readonly sessions = new Map<string, Idle>();

  constructor(private readonly deps: MenuIdleDeps) {}

  // A click in the session starts a new idle period.
  clicked(sessionId: string, at: Instant): void {
    this.record(sessionId, at).since = at;
    this.settle(sessionId);
  }

  // When the session's idle period began: its last click, or — for a
  // session this daemon has not seen click — its first render here.
  since(sessionId: string, at: Instant): Instant {
    return this.record(sessionId, at).since;
  }

  // What the session's latest render drew: whether a menu row, and the
  // timeout its settings resolve to.
  observe(
    sessionId: string,
    at: Instant,
    shown: boolean,
    timeoutS: number,
  ): void {
    const idle = this.record(sessionId, at);
    idle.shown = shown;
    idle.timeoutS = timeoutS;
    this.settle(sessionId);
  }

  // The sessions whose clocks are kept, and those whose close timer is armed.
  getStats(): MenuIdleStats {
    let armed = 0;
    for (const idle of this.sessions.values()) if (idle.timer !== null) armed++;
    return { sessions: this.sessions.size, armed };
  }

  dispose(): void {
    for (const idle of this.sessions.values()) this.disarm(idle);
    this.sessions.clear();
  }

  private record(sessionId: string, at: Instant): Idle {
    const idle = this.sessions.get(sessionId) ?? {
      since: at,
      timeoutS: 0,
      shown: false,
      timer: null,
    };
    // Touched last, so evicted last.
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, idle);
    for (const [evicted, gone] of this.sessions) {
      if (this.sessions.size <= MAX_SESSIONS) break;
      this.disarm(gone);
      this.sessions.delete(evicted);
    }
    return idle;
  }

  // [LAW:single-enforcer] The one place the timer follows the record.
  private settle(sessionId: string): void {
    const idle = this.sessions.get(sessionId)!;
    const due = idle.shown ? closesAt(idle.since, idle.timeoutS) : null;
    if (idle.timer?.at === due) return;
    this.disarm(idle);
    if (due === null) return;
    const handle = setTimeout(
      () => this.fire(sessionId),
      Math.max(0, (due - this.deps.now()) * 1000),
    );
    handle.unref();
    idle.timer = { at: due, handle };
  }

  private disarm(idle: Idle): void {
    if (idle.timer !== null) clearTimeout(idle.timer.handle);
    idle.timer = null;
  }

  // The deadline passed with no click: close the menus, and begin a new idle
  // period now. What the last frame drew no longer stands — the close wrote
  // every menu shut — so the timer waits for a render that draws a menu again
  // (a group open by default, a close that failed) and closes it a timeout
  // after this one: never at once, and never for a session that stopped
  // rendering.
  private fire(sessionId: string): void {
    const idle = this.sessions.get(sessionId)!;
    idle.timer = null;
    const now = this.deps.now();
    const closing: IdleClose = {
      idleS: now - idle.since,
      timeoutS: idle.timeoutS,
    };
    idle.since = now;
    idle.shown = false;
    try {
      this.deps.close(sessionId, closing);
    } catch (e) {
      this.deps.failed(sessionId, e);
    }
  }
}
