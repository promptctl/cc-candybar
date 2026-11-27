// [LAW:one-source-of-truth] The host materializes live changes once. A full
// record is needed at boot and at a disk checkpoint. A click touches only the
// named picks, histories and recency links.
import { isPlainObject } from "../config/loader/validate-core.js";
import type { SessionId } from "./foundations/session-id.js";
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
  isStoreWrite,
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
export type DurableWrite = StoreWrite<DurableEdit>;

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
  if (!Array.isArray(raw) || !raw.every((v) => isStoreWrite(v, edit)))
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
  private readonly histories = new RecencyMap<SessionId, SessionHistory>();
  constructor(seed: StoredState) {
    for (const [id, picks] of Object.entries(seed.sessions))
      this.picks.set(id as SessionId, new Map(Object.entries(picks)));
    for (const [id, history] of Object.entries(seed.history))
      this.histories.set(id as SessionId, history);
  }

  snapshot(scope: "live" | "durable"): StoredState {
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
    return {
      sessions: Object.fromEntries(sessions),
      history: Object.fromEntries(history),
    };
  }

  private pick(write: Exclude<StoreWrite, { kind: "steps" }>): void {
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

  private history(id: SessionId, next: SessionHistory): void {
    if (holdsNothing(next)) this.histories.delete(id);
    else this.histories.set(id, next);
  }

  prepare(writes: readonly StoreWrite[]): () => DurableWrite[] {
    // Resolve every ordered history reference before mutating either store.
    // One bad peer message cannot land half a transaction.
    const staged = new Map<SessionId, SessionHistory>();
    const histories: Array<{ next: SessionHistory; edits: DurableEdit[] }> = [];
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
    return () => this.apply(writes, histories);
  }

  private apply(
    writes: readonly StoreWrite[],
    histories: ReadonlyArray<{ next: SessionHistory; edits: DurableEdit[] }>,
  ): DurableWrite[] {
    let at = 0;
    const durable: DurableWrite[] = [];
    for (const write of writes) {
      const heard = {
        kind: "heard",
        store: write.store,
        key: write.key,
      } as const;
      if (write.kind === "steps") {
        const { next, edits } = histories[at++]!;
        this.history(write.key, next);
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
        this.history(write.key, next);
      }
    }
  }
}
