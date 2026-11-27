// [LAW:single-enforcer] The owner of a session store decides its evictions.
// Each decision is an ordinary ordered write, so a peer can apply it directly.
import type { SessionId } from "../daemon/foundations/session-id.js";
import { RecencyMap } from "../utils/recency.js";
import type { SessionHistory, Step } from "./history-storage.js";

export const MAX_PICK_SESSIONS = 256;
const MAX_HISTORY_SESSIONS = 32;
const MAX_HISTORY_WEIGHT = 8 * 1024 * 1024;

export type CapacityOwner = "host" | "renderer";
type Limit =
  | { readonly kind: "clear" }
  | { readonly kind: "trim"; readonly count: number };

// A history moves as one entry. Only changed stacks need weighing, and each
// immutable step keeps its original weight in string code units.
export class HistoryIndex {
  private readonly entries = new RecencyMap<
    SessionId,
    { history: SessionHistory; weight: number }
  >();
  private readonly weights?: WeakMap<Step, number>;
  private weight = 0;

  constructor(measure: boolean) {
    if (measure) this.weights = new WeakMap();
  }

  *[Symbol.iterator](): IterableIterator<[SessionId, SessionHistory]> {
    for (const [key, entry] of this.entries) yield [key, entry.history];
  }

  get(session: SessionId): SessionHistory | undefined {
    return this.entries.get(session)?.history;
  }

  wouldTouch(session: SessionId): boolean {
    return this.entries.wouldTouch(session);
  }

  touch(session: SessionId): boolean {
    return this.entries.touch(session);
  }

  private stepWeight(step: Step): number {
    let weight = this.weights!.get(step);
    if (weight === undefined) {
      weight = step.reduce(
        (sum, change) =>
          sum + (change.before?.length ?? 0) + (change.after?.length ?? 0),
        0,
      );
      this.weights!.set(step, weight);
    }
    return weight;
  }

  private historyWeight(history: SessionHistory): number {
    let cost = 0;
    for (const stack of [history.past, history.future])
      for (const step of stack) cost += this.stepWeight(step);
    return cost;
  }

  set(session: SessionId, next: SessionHistory): void {
    const weight = this.weights ? this.historyWeight(next) : 0;
    this.weight += weight - (this.entries.get(session)?.weight ?? 0);
    this.entries.set(session, { history: next, weight });
  }

  delete(session: SessionId): void {
    this.weight -= this.entries.get(session)?.weight ?? 0;
    this.entries.delete(session);
  }

  excess(): { readonly key: SessionId; readonly edit: Limit } | undefined {
    if (
      !this.weights ||
      (this.entries.size <= MAX_HISTORY_SESSIONS &&
        this.weight <= MAX_HISTORY_WEIGHT)
    )
      return undefined;
    const key = this.entries.oldest!;
    if (this.entries.size > 1) return { key, edit: { kind: "clear" } };
    const history = this.get(key)!;
    let remaining = this.weight;
    let count = 0;
    for (const stack of [history.past, history.future])
      for (const step of stack) {
        remaining -= this.stepWeight(step);
        count++;
        if (remaining <= MAX_HISTORY_WEIGHT)
          return { key, edit: { kind: "trim", count } };
      }
    throw new Error("history weight exceeds all held steps");
  }
}
