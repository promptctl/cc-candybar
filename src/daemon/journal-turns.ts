// [LAW:no-ambient-temporal-coupling][LAW:single-enforcer] The one owner of when
// a journal is open. A turn's work is synchronous: its body runs to completion
// in the call that takes it, so no other turn, no draw and no other writer can
// run between a journal's begin and its commit, and a turn waits on nothing.
// That is what keeps two journals apart, daemon-wide and not per session,
// because a session's history is its own but the config files it writes are
// shared. A turn fences synchronous work alone: a render request, a click and
// an effect's outcome each take one and are never queued behind another's
// awaits.
//
// What a turn would wait on is an effect (src/daemon/effect.ts): a click
// describes it in its turn, the performer runs it after (src/daemon/apply.ts),
// and its outcome lands in a turn of its own. A doctor's probes are such an
// effect, gathered here one at a time daemon-wide (`gathering`), in no turn.
// One that never settles shows in `getStats().gathers` and holds nothing else.
//
// `close` ends the turns for good: every take after it is refused, and since
// no turn is ever in flight across an await, there is nothing to cut off. A
// gather whose place comes after it is refused too, since no turn would land
// what its probes found.

import type { Lane } from "../config/lanes.js";
import { paneName, type TmuxHint } from "../tmux-hint.js";
import { KeyedSerialQueue } from "../utils/keyed-serial-queue.js";
import { DaemonClosing } from "./verb-error.js";

// [LAW:types-are-the-program] A turn body's answer: anything but a promise, so
// an async body, whose writes after its first await would land outside its
// turn, fails to build.
export type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;

export interface JournalTurnStats {
  // Gathers running or queued, which hold no turn: one that never settles
  // reads here and nowhere else.
  readonly gathers: number;
}

const GATHERS = "gathers";

// [LAW:no-ambient-temporal-coupling][LAW:types-are-the-program] The order an
// effect takes its place in: one session's clicks as they committed (and
// those of clicks naming none, among themselves), what is typed into one tmux
// pane, or one lane of a session's setups.
export type OrderingKey =
  | { readonly kind: "session"; readonly session: string | null }
  | { readonly kind: "pane"; readonly tmux: TmuxHint }
  | { readonly kind: "lane"; readonly session: string; readonly lane: Lane };

// A key as the queue holds it.
const QUEUED: {
  readonly [K in OrderingKey["kind"]]: (
    key: Extract<OrderingKey, { readonly kind: K }>,
  ) => readonly unknown[];
} = {
  session: ({ session }) => ["session", session],
  pane: ({ tmux }) => ["pane", paneName(tmux)],
  lane: ({ session, lane }) => ["lane", session, lane],
};

function queuedAs<K extends OrderingKey["kind"]>(
  key: Extract<OrderingKey, { readonly kind: K }>,
): string {
  const queued: (typeof QUEUED)[K] = QUEUED[key.kind];
  return JSON.stringify(queued(key));
}

export class JournalTurns {
  private readonly gathers = new KeyedSerialQueue<typeof GATHERS>();
  private readonly effects = new KeyedSerialQueue<string>();
  private open = true;
  private holder: string | null = null;
  private gathersInFlight = 0;

  // Runs `body` as `verb`'s turn and answers what it answered, or throws what
  // it threw. Refused once the daemon has closed, and inside another turn: a
  // turn nested in a turn would nest two journals.
  take<T>(verb: string, body: () => Synchronous<T>): T {
    if (!this.open) throw new DaemonClosing(verb);
    if (this.holder !== null) {
      throw new Error(`journal: ${verb} took a turn inside ${this.holder}'s`);
    }
    this.holder = verb;
    try {
      return body() as T;
    } finally {
      this.holder = null;
    }
  }

  // [LAW:single-enforcer] The verb whose turn body is running now, or null.
  // Turns are synchronous, so a write made while one is held is that turn's.
  inTurn(): string | null {
    return this.holder;
  }

  // A doctor's gather, one at a time daemon-wide and in no turn: its probes
  // share rate windows across sessions, so a slow gather refuses none behind
  // it. Two within a window still meet the limiter's refusal, the doctor's
  // 'click again'.
  async gathering<G>(gather: () => Promise<G>): Promise<G> {
    this.gathersInFlight++;
    try {
      return await this.gathers.run(GATHERS, () => {
        if (!this.open) throw new DaemonClosing("doctor");
        return gather();
      });
    } finally {
      this.gathersInFlight--;
    }
  }

  // [LAW:no-ambient-temporal-coupling] The effects on one key run one at a
  // time, in the order their places were taken, each after the last: a
  // performer that reads before it acts (the pane read before a slash is
  // typed) sees what the earlier effects on that thing left, and two doctor
  // clicks of one session reach their verdicts in the order they were
  // clicked. Effects on different keys wait on each other only through their
  // own event's order and through a setup's pane step, which waits in its
  // pane's order; keeping those waits acyclic is the performer's
  // (src/daemon/apply.ts `performAll`). The order is the performer's, not the
  // turn's: the session's next click takes its turn while the last click's
  // effects still run, and no close refuses it, since an outcome after close
  // is said in the log.
  performing<T>(key: OrderingKey, work: () => Promise<T>): Promise<T> {
    return this.effects.run(queuedAs(key), work);
  }

  getStats(): JournalTurnStats {
    return { gathers: this.gathersInFlight };
  }

  close(): void {
    this.open = false;
  }
}
