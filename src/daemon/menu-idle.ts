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
//
// While a click of the session is in flight no deadline exists: its gather and
// its queues are not idleness, whatever they take. Only a landing moves the
// clock, so an abandoned click restarts nothing.

import { closesAt } from "../config/menu-timeout.js";
import type { Instant } from "../utils/instant.js";
import type { IdleClose } from "./verbs/index.js";

interface Idle {
  since: Instant;
  timeoutS: number;
  shown: boolean;
  // The instant of the frame `shown` and `timeoutS` were read off.
  drawnAt: Instant;
  timer: { readonly at: Instant; readonly handle: NodeJS.Timeout } | null;
  // A close is waiting for its turn or running: no second one is due.
  closing: boolean;
}

export interface MenuIdleStats {
  readonly sessions: number;
  readonly armed: number;
  // Clicks in flight, from arrival until they land or are refused.
  readonly pending: number;
}

export interface MenuIdleDeps {
  // The instant now, on the clock renders are drawn by.
  readonly now: () => Instant;
  // Close the session's menus: the journaled write a ✕ makes
  // (`closeIdleMenus`, src/daemon/verbs/index.ts).
  readonly close: (sessionId: string, idle: IdleClose) => Promise<void>;
  // [LAW:no-silent-failure] A close that rejected: a timer has no caller to
  // reject to, and an unhandled rejection would end the daemon.
  readonly failed: (sessionId: string, error: unknown) => void;
}

// The sessions whose clocks are kept, as many as the daemon keeps effects for;
// the least recently touched goes first, and its timer with it.
const MAX_SESSIONS = 256;

export class MenuIdle {
  private readonly sessions = new Map<string, Idle>();
  // Clicks in flight per session, entries deleted at zero. Apart from the
  // records, which eviction drops under a click that is still in flight.
  private readonly pending = new Map<string, number>();
  private disposed = false;

  constructor(private readonly deps: MenuIdleDeps) {}

  // A click in the session starts a new idle period.
  clicked(sessionId: string, at: Instant): void {
    const idle = this.record(sessionId, at);
    idle.since = at;
    this.settle(sessionId);
  }

  // A click of the session arrived: no deadline until it settles.
  clickArrived(sessionId: string): void {
    this.pending.set(sessionId, (this.pending.get(sessionId) ?? 0) + 1);
    if (this.sessions.has(sessionId)) this.settle(sessionId);
  }

  // A click of the session landed or was refused, after any landing stamp. A
  // record evicted meanwhile has no timer left to follow it.
  clickSettled(sessionId: string): void {
    const left = this.pending.get(sessionId)! - 1;
    if (left === 0) this.pending.delete(sessionId);
    else this.pending.set(sessionId, left);
    if (this.sessions.has(sessionId)) this.settle(sessionId);
  }

  // When the idle period of the menus the session's last frame drew began —
  // its last click, or the first frame that drew them, whichever is later —
  // or nothing, while it drew none: a menu that appears now has only begun.
  since(sessionId: string, at: Instant): Instant | undefined {
    const idle = this.record(sessionId, at);
    return idle.shown ? idle.since : undefined;
  }

  // What the session's newest frame drew: whether a menu row, and the
  // timeout its settings resolve to. Frames are taken by their instant, not
  // by when their render finished, so a render that outlived a newer one
  // tells nothing. A menu drawn where the last frame drew none begins its
  // idle period here, so one nobody clicked open (a group open by default,
  // from a reload) is not closed by a click from long ago.
  observe(
    sessionId: string,
    at: Instant,
    shown: boolean,
    timeoutS: number,
  ): void {
    const idle = this.record(sessionId, at);
    if (at < idle.drawnAt) return;
    idle.drawnAt = at;
    if (shown && !idle.shown && at > idle.since) idle.since = at;
    idle.shown = shown;
    idle.timeoutS = timeoutS;
    this.settle(sessionId);
  }

  // The sessions whose clocks are kept, and those whose close timer is armed.
  getStats(): MenuIdleStats {
    let armed = 0;
    for (const idle of this.sessions.values()) if (idle.timer !== null) armed++;
    let pending = 0;
    for (const count of this.pending.values()) pending += count;
    return { sessions: this.sessions.size, armed, pending };
  }

  dispose(): void {
    this.disposed = true;
    for (const idle of this.sessions.values()) this.disarm(idle);
    this.sessions.clear();
  }

  private record(sessionId: string, at: Instant): Idle {
    const idle = this.sessions.get(sessionId) ?? {
      since: at,
      timeoutS: 0,
      shown: false,
      drawnAt: at,
      timer: null,
      closing: false,
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
    // [LAW:no-ambient-temporal-coupling] Disposed, nothing is due: a render
    // that was awaiting when the daemon closed arms no timer as it lands.
    const due =
      idle.shown &&
      !idle.closing &&
      !this.disposed &&
      !this.pending.has(sessionId)
        ? closesAt(idle.since, idle.timeoutS)
        : null;
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
  // rendering. [LAW:no-ambient-temporal-coupling] The close waits its turn
  // among the journals, so whether the session is still idle is read in that
  // turn: a click since this firing keeps what it opened. The record follows that decision (`closed`), and until the
  // close settles no frame arms another. A close that failed waits a timeout
  // too, so it is retried at that pace and not at every frame.
  private fire(sessionId: string): void {
    const idle = this.sessions.get(sessionId)!;
    idle.timer = null;
    const now = this.deps.now();
    const closing: IdleClose = {
      idleS: now - idle.since,
      timeoutS: idle.timeoutS,
      // A click arrived after this firing is queued behind the close, and an
      // evicted record stops counting, so its session is no longer known idle.
      stillIdle: () =>
        this.sessions.get(sessionId) === idle && !this.pending.has(sessionId),
      closed: () => {
        idle.since = now;
        idle.shown = false;
      },
    };
    idle.closing = true;
    this.deps
      .close(sessionId, closing)
      .catch((e: unknown) => {
        closing.closed();
        this.deps.failed(sessionId, e);
      })
      .finally(() => {
        idle.closing = false;
        // [LAW:no-ambient-temporal-coupling] A record evicted or disposed
        // meanwhile has no timer left to follow it.
        if (this.sessions.get(sessionId) === idle) this.settle(sessionId);
      });
  }
}
