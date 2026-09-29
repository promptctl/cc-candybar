import type {
  CeilingMove,
  CeilingReading,
  CeilingScope,
  MementoEdge,
} from "../memento/edge.js";
import type { Outcome } from "../utils/outcome.js";

// How long a session's reading stands before the next render asks memento
// again. A move from the bar drops the reading at once (`move` below); this
// bounds only how late the bar learns of a move made elsewhere — the
// `/memento:ceiling` skill, a hand edit, memento's own /clear hook.
const READING_TTL_MS = 10_000;
const MAX_ENTRIES = 64;

interface Entry {
  readonly outcome: Outcome<CeilingReading>;
  readonly at: number;
}

const keyOf = (s: CeilingScope): string =>
  `${s.sessionId}|${s.projectDir}|${s.cwd}`;

// The bar's view of memento's context ceiling, per session: the reading each
// render shows, and the one way a click moves it.
//
// [LAW:single-enforcer] Reading and moving share this owner, so a move and the
// cache it invalidates cannot drift apart: after `move` returns, the next
// render asks memento afresh and draws what the move actually left.
export class MementoProvider {
  private readonly readings = new Map<string, Entry>();
  // [LAW:no-ambient-temporal-coupling] The one read a key may cache from. A
  // move replaces it, so a read that was already in flight when the click
  // landed is handed to its caller but never cached as the session's reading
  // — it describes the layer before the move.
  private readonly inFlight = new Map<
    string,
    Promise<Outcome<CeilingReading>>
  >();

  constructor(
    private readonly edge: MementoEdge,
    private readonly now: () => number = Date.now,
  ) {}

  // absent — memento is not installed (or not enabled) for this project;
  // failed — memento refused (an unreadable layer: the very state that
  // switches its gate off). An expired reading is still drawn while its
  // replacement is fetched: a python spawn does not fit in a render's budget,
  // so only a session with no reading at all waits on one.
  getCeiling(scope: CeilingScope): Promise<Outcome<CeilingReading>> {
    const key = keyOf(scope);
    const cached = this.readings.get(key);
    if (cached && this.now() - cached.at < READING_TTL_MS) {
      return Promise.resolve(cached.outcome);
    }
    const fetched = this.inFlight.get(key) ?? this.fetch(key, scope);
    return cached ? Promise.resolve(cached.outcome) : fetched;
  }

  private fetch(
    key: string,
    scope: CeilingScope,
  ): Promise<Outcome<CeilingReading>> {
    const located = this.edge.locate(scope.projectDir);
    const fetched: Promise<Outcome<CeilingReading>> = (
      located.kind === "ok"
        ? this.edge.read(located.value, scope)
        : Promise.resolve(located)
    )
      .then((outcome) => {
        if (this.inFlight.get(key) !== fetched) return outcome;
        this.readings.delete(key);
        this.readings.set(key, { outcome, at: this.now() });
        while (this.readings.size > MAX_ENTRIES) {
          this.readings.delete(this.readings.keys().next().value!);
        }
        return outcome;
      })
      .finally(() => {
        if (this.inFlight.get(key) === fetched) this.inFlight.delete(key);
      });
    this.inFlight.set(key, fetched);
    return fetched;
  }

  // [LAW:no-silent-failure] Memento absent is a refusal here, not a no-op: a
  // click that moved nothing must say so.
  move(scope: CeilingScope, m: CeilingMove): void {
    const located = this.edge.locate(scope.projectDir);
    if (located.kind !== "ok") {
      throw new Error(
        located.kind === "failed"
          ? located.reason
          : "memento is not installed or not enabled for this project",
      );
    }
    const key = keyOf(scope);
    try {
      this.edge.move(located.value, scope, m);
    } finally {
      // Replaced even when memento refused: the refusal may name a layer that
      // changed under it, which the next render should show as it now stands.
      // The render after the click joins this read instead of starting one.
      this.readings.delete(key);
      this.inFlight.delete(key);
      void this.fetch(key, scope);
    }
  }
}
