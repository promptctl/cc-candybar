// [LAW:one-source-of-truth] The host materializes live changes once. A full
// record is needed at boot and at a disk checkpoint. A click touches only the
// named picks, histories and recency links.
import { isPlainObject } from "../config/loader/validate-core.js";
import type { SessionId } from "./foundations/session-id.js";
import {
  HistoryIndex,
  MAX_PICK_SESSIONS,
} from "../renderer-interface/session-capacity.js";
import {
  EMPTY_TIMELINE,
  MAX_NAVIGATION_SESSIONS,
  stageNavigation,
  type Timeline,
} from "../renderer-interface/navigation.js";
import { DraftBook } from "../renderer-interface/draft.js";
import { RecencyMap } from "../utils/recency.js";
import {
  durableHistory,
  durableTarget,
  EMPTY_HISTORY,
  historyAfter,
  holdsNothing,
  isHistoryEdit,
  type HistoryEdit,
  type SessionHistory,
  type Step,
} from "../renderer-interface/history-storage.js";
import {
  durablePickValue,
  isProfileWrite,
  type ProfileWrite,
  type LiveSessionState,
  type StoreWrite,
  type StoredState,
} from "../renderer-interface/stored-state.js";

// Private steps never reach disk. If one consumed a place in a capped stack,
// record the public steps that actually fell off its front. A private append
// also invalidates redo, even when it contributed no public step.
interface Cut {
  readonly kind: "cut";
  readonly past: number;
  readonly future: number;
  readonly clearFuture: boolean;
}
export type DurableEdit = HistoryEdit | Cut;
export type DurableWrite = ProfileWrite<DurableEdit>;

// [LAW:parse-dont-validate] A valid checksum establishes the recorded bytes.
// Admit only decisions this build knows how to apply to its recovered state.
export function durableWritesOf(raw: unknown): readonly DurableWrite[] {
  const count = (n: unknown) =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const edit = (e: unknown): e is DurableEdit =>
    isHistoryEdit(e) ||
    (isPlainObject(e) &&
      e.kind === "cut" &&
      count(e.past) &&
      count(e.future) &&
      typeof e.clearFuture === "boolean");
  if (!Array.isArray(raw) || !raw.every((v) => isProfileWrite(v, edit)))
    throw new Error("invalid durable session changes");
  return raw;
}

function cut(history: SessionHistory, edit: Cut): SessionHistory {
  if (edit.past > history.past.length || edit.future > history.future.length)
    throw new Error("durable history cut exceeds the stack");
  return {
    past: history.past.slice(edit.past),
    future: edit.clearFuture ? [] : history.future.slice(edit.future),
  };
}

function publicEdits(
  prior: SessionHistory,
  edit: HistoryEdit,
  next: SessionHistory,
): DurableEdit[] {
  const visible = (step: Step) => step.some(durableTarget);
  const lost = (stack: readonly Step[], count: number) =>
    stack.slice(0, count).filter(visible).length;
  switch (edit.kind) {
    case "clear":
      return [edit];
    case "forget": {
      const targets = edit.targets.filter(durableTarget);
      return targets.length ? [{ kind: "forget", targets }] : [];
    }
    case "trim": {
      const count =
        lost(prior.past, prior.past.length - next.past.length) +
        lost(prior.future, prior.future.length - next.future.length);
      return count ? [{ kind: "trim", count }] : [];
    }
    case "append":
    case "undo":
    case "redo": {
      const dest = edit.kind === "undo" ? "future" : "past";
      const n = lost(prior[dest], prior[dest].length + 1 - next[dest].length);
      const step =
        edit.kind === "append"
          ? edit.step
          : prior[edit.kind === "undo" ? "past" : "future"].at(-1)!;
      const add =
        edit.kind === "append" ? step.filter(durableTarget) : undefined;
      const move = add === undefined ? visible(step) : add.length > 0;
      const clearFuture =
        edit.kind === "append" && !move && prior.future.some(visible);
      const edits: DurableEdit[] = [];
      if (n || clearFuture)
        edits.push({
          kind: "cut",
          past: dest === "past" ? n : 0,
          future: dest === "future" ? n : 0,
          clearFuture,
        });
      if (move)
        edits.push(
          edit.kind === "append" ? { kind: "append", step: add! } : edit,
        );
      return edits;
    }
  }
}

export class HostSessionImage {
  private readonly picks = new RecencyMap<SessionId, Map<string, string>>();
  private readonly histories: HistoryIndex;
  private readonly drafts = new DraftBook();
  private readonly navigation = new RecencyMap<SessionId, Timeline>();
  constructor(seed: StoredState, purpose: "live" | "recovery" = "live") {
    this.histories = new HistoryIndex(purpose === "live");
    for (const [id, picks] of Object.entries(seed.sessions))
      this.picks.set(id as SessionId, new Map(Object.entries(picks)));
    for (const [id, history] of Object.entries(seed.history))
      this.setHistory(id as SessionId, history);
  }

  hasDraft(session: SessionId): boolean {
    return this.drafts.get(session) !== undefined;
  }

  snapshot(scope: "live"): LiveSessionState;
  snapshot(scope: "durable"): StoredState;
  snapshot(scope: "live" | "durable"): LiveSessionState {
    const sessions = new Map<SessionId, Readonly<Record<string, string>>>();
    for (const [id, values] of this.picks) {
      if (scope === "live") sessions.set(id, Object.fromEntries(values));
      else {
        const kept = [...values].filter(
          ([key, value]) => durablePickValue(key, value) !== null,
        );
        if (kept.length) sessions.set(id, Object.fromEntries(kept));
      }
    }
    const history = new Map<SessionId, SessionHistory>();
    for (const [id, value] of this.histories) {
      const kept = scope === "live" ? value : durableHistory(value);
      if (kept !== null) history.set(id, kept);
    }
    const drafts = scope === "live" ? this.drafts.snapshot() : undefined;
    return {
      ...(drafts && { drafts }),
      sessions: Object.fromEntries(sessions),
      history: Object.fromEntries(history),
      ...(scope === "live" &&
        this.navigation.size > 0 && {
          navigation: Object.fromEntries(this.navigation),
        }),
    };
  }

  private pick(write: Exclude<ProfileWrite, { kind: "steps" }>): void {
    if (write.kind === "heard") {
      (write.store === "session-state" ? this.picks : this.histories).touch(
        write.key,
      );
    } else if (write.kind === "drop") this.picks.delete(write.key);
    else {
      const picks = this.picks.get(write.key) ?? new Map<string, string>();
      for (const [key, value] of Object.entries(write.changes)) {
        if (value === null) picks.delete(key);
        else picks.set(key, value);
      }
      if (picks.size) this.picks.set(write.key, picks);
      else this.picks.delete(write.key);
    }
  }

  private setHistory(key: SessionId, next: SessionHistory): void {
    if (holdsNothing(next)) this.histories.delete(key);
    else this.histories.set(key, next);
  }

  // The host heard the request. A peer boot replaying old contexts is never a
  // new request, and a worker can lag a more recent hearing on another peer.
  hearing(key: SessionId): StoreWrite[] {
    const writes: StoreWrite[] = [];
    if (this.picks.wouldTouch(key))
      writes.push({ kind: "heard", store: "session-state", key });
    if (this.histories.wouldTouch(key))
      writes.push({ kind: "heard", store: "settings-history", key });
    return writes;
  }

  // Evictions are decided after every authored write has taken its place in
  // recency order. Persist and publish the same removals as the original turn.
  bound(): { writes: StoreWrite[]; durable: DurableWrite[] } {
    const writes: StoreWrite[] = [],
      durable: DurableWrite[] = [];
    while (this.picks.size > MAX_PICK_SESSIONS) {
      const drop = {
        store: "session-state",
        kind: "drop",
        key: this.picks.oldest!,
      } as const;
      this.picks.delete(drop.key);
      writes.push(drop);
      durable.push(drop);
    }
    for (let limit; (limit = this.histories.excess()) !== undefined; ) {
      const { key, edit } = limit;
      const prior = this.histories.get(key)!;
      const next = historyAfter(prior, edit);
      this.setHistory(key, next);
      const steps = {
        store: "settings-history",
        kind: "steps",
        key,
        edits: [edit],
      } as const;
      writes.push(steps);
      durable.push({ ...steps, edits: publicEdits(prior, edit, next) });
    }
    while (this.navigation.size > MAX_NAVIGATION_SESSIONS) {
      const key = this.navigation.oldest!;
      this.navigation.delete(key);
      writes.push({ kind: "drop", store: "navigation", key });
    }
    return { writes, durable };
  }

  prepare(
    writes: readonly StoreWrite[],
  ): () => { writes: readonly StoreWrite[]; durable: readonly DurableWrite[] } {
    // Resolve every ordered history reference before mutating either store.
    // One bad peer message cannot land half a transaction.
    const staged = new Map<SessionId, SessionHistory>();
    const histories: Array<{ next: SessionHistory; edits: DurableEdit[] }> = [];
    const applyDrafts = this.drafts.prepare(
      writes.filter((w) => w.store === "draft"),
    );
    const navigation = stageNavigation(
      writes,
      (key) => this.navigation.get(key) ?? EMPTY_TIMELINE,
    );
    for (const write of writes) {
      if (write.kind !== "steps") continue;
      let prior =
        staged.get(write.key) ?? this.histories.get(write.key) ?? EMPTY_HISTORY;
      const edits: DurableEdit[] = [];
      for (const edit of write.edits) {
        const next = historyAfter(prior, edit);
        edits.push(...publicEdits(prior, edit, next));
        prior = next;
      }
      staged.set(write.key, prior);
      histories.push({ next: prior, edits });
    }
    return () => {
      applyDrafts();
      const durable = this.apply(writes, histories, navigation);
      const expired = this.bound();
      if (!expired.writes.length) return { writes, durable };
      return {
        writes: [...writes, ...expired.writes],
        durable: [...durable, ...expired.durable],
      };
    };
  }

  private apply(
    writes: readonly StoreWrite[],
    histories: ReadonlyArray<{ next: SessionHistory; edits: DurableEdit[] }>,
    navigation: ReadonlyMap<SessionId, Timeline>,
  ): DurableWrite[] {
    let at = 0;
    const durable: DurableWrite[] = [];
    for (const write of writes) {
      if (write.store === "navigation" || write.store === "draft") continue;
      const heard = {
        kind: "heard",
        store: write.store,
        key: write.key,
      } as const;
      if (write.kind === "steps") {
        const { next, edits } = histories[at++]!;
        this.setHistory(write.key, next);
        durable.push(edits.length ? { ...write, edits } : heard);
      } else if (write.kind === "patch") {
        const prior = this.picks.get(write.key);
        const changes = new Map<string, string | null>();
        for (const [key, value] of Object.entries(write.changes)) {
          const after = durablePickValue(key, value);
          if (
            after !== null ||
            durablePickValue(key, prior?.get(key) ?? null) !== null
          )
            changes.set(key, after);
        }
        this.pick(write);
        durable.push(
          changes.size
            ? { ...write, changes: Object.fromEntries(changes) }
            : heard,
        );
      } else {
        this.pick(write);
        durable.push(write);
      }
    }
    for (const [key, timeline] of navigation) {
      if (timeline.visits.length) this.navigation.set(key, timeline);
      else this.navigation.delete(key);
    }
    return durable;
  }

  recover(writes: readonly DurableWrite[]): void {
    for (const write of writes) {
      if (write.kind !== "steps") this.pick(write);
      else {
        const next = write.edits.reduce(
          (h, e) => (e.kind === "cut" ? cut(h, e) : historyAfter(h, e)),
          this.histories.get(write.key) ?? EMPTY_HISTORY,
        );
        this.setHistory(write.key, next);
      }
    }
  }
}
