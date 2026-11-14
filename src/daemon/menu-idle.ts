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
import type { IdleSpan } from "./verbs/index.js";
import type { RendererHost } from "./renderer-host.js";
import type { SessionId } from "./session-id.js";
import type { Failure } from "./verb-error.js";
import type { Timekeeper } from "../time";

// [LAW:no-silent-failure] The idle close as a `menu-idle` turn of the
// renderer, answering with its failure, or null when it closed. The clock
// hears a failure, then waits a timeout before trying again, and its `failed`
// writes the one line, so nothing else is logged here.
export async function closeByTurn(
  host: Pick<RendererHost, "answer">,
  at: () => Instant,
  sessionId: SessionId,
  idle: IdleSpan,
): Promise<Failure | null> {
  const delivered = await host.answer({
    kind: "event",
    at: at(),
    event: { kind: "menu-idle", session: sessionId, idle },
  });
  return delivered.kind === "threw" ? delivered.failure : null;
}

interface Idle {
  since: Instant;
  timeoutS: number;
  shown: boolean;
  // The instant of the frame `shown` and `timeoutS` were read off.
  drawnAt: Instant;
  timer: { readonly at: Instant; readonly clear: () => void } | null;
  // When the close now waiting for its turn or running fired: no second one
  // is due.
  closing: Instant | null;
}

export interface MenuIdleStats {
  readonly sessions: number;
  readonly armed: number;
  // Clicks in flight, from arrival until they land or are refused.
  readonly pending: number;
}

export interface MenuIdleDeps {
  // The daemon's clock, which the close timers run on.
  readonly clock: Pick<Timekeeper, "after">;
  // The instant now, on the clock renders are drawn by.
  readonly now: () => Instant;
  // Close the session's menus: the journaled write a ✕ makes
  // (`closeIdleMenus`, src/daemon/verbs/index.ts), as a renderer turn
  // (`closeByTurn`), which asks `confirmClose` in its turn.
  readonly close: (
    sessionId: SessionId,
    idle: IdleSpan,
  ) => Promise<Failure | null>;
  // [LAW:no-silent-failure] A close that failed: a timer has no caller to
  // fail to.
  readonly failed: (sessionId: SessionId, failure: Failure) => void;
}

// The sessions whose clocks are kept, as many as the daemon keeps effects for;
// the least recently touched goes first, and its timer with it.
const MAX_SESSIONS = 256;

export class MenuIdle {
  private readonly sessions = new Map<SessionId, Idle>();
  // Clicks in flight per session, entries deleted at zero. Apart from the
  // records, which eviction drops under a click that is still in flight.
  private readonly pending = new Map<SessionId, number>();
  private disposed = false;

  constructor(private readonly deps: MenuIdleDeps) {}

  // A click in the session starts a new idle period.
  clicked(sessionId: SessionId, at: Instant): void {
    const idle = this.record(sessionId, at);
    idle.since = at;
    this.settle(sessionId);
  }

  // A click of the session arrived: no deadline until it settles.
  clickArrived(sessionId: SessionId): void {
    this.pending.set(sessionId, (this.pending.get(sessionId) ?? 0) + 1);
    if (this.sessions.has(sessionId)) this.settle(sessionId);
  }

  // A click of the session landed or was refused, after any landing stamp. A
  // record evicted meanwhile has no timer left to follow it.
  clickSettled(sessionId: SessionId): void {
    const left = this.pending.get(sessionId)! - 1;
    if (left === 0) this.pending.delete(sessionId);
    else this.pending.set(sessionId, left);
    if (this.sessions.has(sessionId)) this.settle(sessionId);
  }

  // When the idle period of the menus the session's last frame drew began —
  // its last click, or the first frame that drew them, whichever is later —
  // or nothing, while it drew none: a menu that appears now has only begun.
  // Nothing too while a click is in flight: no close is due to count down to.
  since(sessionId: SessionId, at: Instant): Instant | undefined {
    const idle = this.record(sessionId, at);
    return idle.shown && !this.pending.has(sessionId) ? idle.since : undefined;
  }

  // What the session's newest frame drew: whether a menu row, and the
  // timeout its settings resolve to. Frames are taken by their instant, not
  // by when their render finished, so a render that outlived a newer one
  // tells nothing. A menu drawn where the last frame drew none begins its
  // idle period here, so one nobody clicked open (a group open by default,
  // from a reload) is not closed by a click from long ago.
  observe(
    sessionId: SessionId,
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

  // In the turn of a close the timer fired: whether it goes ahead, the session
  // still known idle since. A click arrived after the firing is queued behind
  // the close, and a record evicted meanwhile stops counting, so neither is
  // known idle. Read without making a record, which would count as a session
  // touched. When it goes ahead, the record follows it.
  confirmClose(sessionId: SessionId): boolean {
    const idle = this.sessions.get(sessionId);
    if (idle?.closing == null || this.pending.has(sessionId)) return false;
    this.shut(idle, idle.closing);
    return true;
  }

  // The sessions whose clocks are kept, those whose close timer is armed, and
  // the clicks in flight.
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

  private record(sessionId: SessionId, at: Instant): Idle {
    const idle = this.sessions.get(sessionId) ?? {
      since: at,
      timeoutS: 0,
      shown: false,
      drawnAt: at,
      timer: null,
      closing: null,
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
  private settle(sessionId: SessionId): void {
    const idle = this.sessions.get(sessionId)!;
    // [LAW:no-ambient-temporal-coupling] Disposed, nothing is due: a render
    // that was awaiting when the daemon closed arms no timer as it lands.
    const due =
      idle.shown &&
      idle.closing === null &&
      !this.disposed &&
      !this.pending.has(sessionId)
        ? closesAt(idle.since, idle.timeoutS)
        : null;
    if (idle.timer?.at === due) return;
    this.disarm(idle);
    if (due === null) return;
    const clear = this.deps.clock.after(
      Math.max(0, (due - this.deps.now()) * 1000),
      () => this.fire(sessionId),
      { unref: true },
    );
    idle.timer = { at: due, clear };
  }

  // A close went ahead or failed: what the last frame drew no longer stands,
  // and a new idle period begins when it fired.
  private shut(idle: Idle, at: Instant): void {
    idle.since = at;
    idle.shown = false;
  }

  private disarm(idle: Idle): void {
    idle.timer?.clear();
    idle.timer = null;
  }

  // The deadline passed with no click: close the menus, and begin a new idle
  // period now. What the last frame drew no longer stands — the close wrote
  // every menu shut — so the timer waits for a render that draws a menu again
  // (a group open by default, a close that failed) and closes it a timeout
  // after this one: never at once, and never for a session that stopped
  // rendering. [LAW:no-ambient-temporal-coupling] The close waits its turn
  // among the journals, so whether the session is still idle is read in that
  // turn: a click since this firing keeps what it opened. The record follows
  // that decision (`confirmClose`), and until the close settles no frame arms
  // another. A close that failed waits a timeout too, so it is retried at that
  // pace and not at every frame.
  private fire(sessionId: SessionId): void {
    const idle = this.sessions.get(sessionId)!;
    idle.timer = null;
    const now = this.deps.now();
    idle.closing = now;
    void this.deps
      .close(sessionId, { idleS: now - idle.since, timeoutS: idle.timeoutS })
      .then((failure) => {
        if (failure === null) return;
        this.shut(idle, now);
        this.deps.failed(sessionId, failure);
      })
      .finally(() => {
        idle.closing = null;
        // [LAW:no-ambient-temporal-coupling] A record evicted or disposed
        // meanwhile has no timer left to follow it.
        if (this.sessions.get(sessionId) === idle) this.settle(sessionId);
      });
  }
}
