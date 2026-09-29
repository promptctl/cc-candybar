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
  private readonly inFlight = new Map<
    string,
    Promise<Outcome<CeilingReading>>
  >();
  // [LAW:no-ambient-temporal-coupling] Bumped by every move, so a read that
  // was already in flight when the click landed is handed to its caller but
  // never cached as the session's reading — it describes the layer before
  // the move.
  private readonly moves = new Map<string, number>();

  constructor(
    private readonly edge: MementoEdge,
    private readonly now: () => number = Date.now,
  ) {}

  // absent — memento is not installed for this project; failed — memento
  // refused (an unreadable layer: the very state that switches its gate off).
  getCeiling(scope: CeilingScope): Promise<Outcome<CeilingReading>> {
    const key = keyOf(scope);
    const cached = this.readings.get(key);
    if (cached && this.now() - cached.at < READING_TTL_MS) {
      return Promise.resolve(cached.outcome);
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const epoch = this.moves.get(key) ?? 0;
    const located = this.edge.locate(scope.projectDir);
    const fetched = (
      located.kind === "ok"
        ? this.edge.read(located.value, scope)
        : Promise.resolve(located)
    )
      .then((outcome) => {
        if ((this.moves.get(key) ?? 0) !== epoch) return outcome;
        this.readings.delete(key);
        this.readings.set(key, { outcome, at: this.now() });
        while (this.readings.size > MAX_ENTRIES) {
          this.readings.delete(this.readings.keys().next().value!);
        }
        return outcome;
      })
      .finally(() => {
        // A move may already have replaced this read with a newer one.
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
          : "memento is not installed for this project",
      );
    }
    const key = keyOf(scope);
    try {
      this.edge.move(located.value, scope, m);
    } finally {
      // Dropped even when memento refused: the refusal may name a layer that
      // changed under it, which the next render should show as it now stands.
      this.readings.delete(key);
      this.inFlight.delete(key);
      this.moves.set(key, (this.moves.get(key) ?? 0) + 1);
    }
  }
}
