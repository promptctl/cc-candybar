import type {
  CeilingMove,
  CeilingReading,
  CeilingScope,
  MementoEdge,
} from "../memento/edge.js";
import { MEMENTO_ENV_VARS } from "../memento-hint.js";
import type { Holds } from "../utils/holds.js";
import { KeyedSource, type KeyedSourceStats } from "../utils/keyed-source.js";
import { quietLogger, type DaemonLogger } from "../utils/logger.js";
import type { Outcome } from "../utils/outcome.js";

// The period a held session's reading is asked again on. A move from the bar
// supersedes the reading at once (`move` below); this bounds only how late the
// bar learns of a move made elsewhere — the `/memento:ceiling` skill, a hand
// edit, memento's own /clear hook.
export const READING_PERIOD_MS = 10_000;
const MAX_ENTRIES = 64;

// Every field of the scope: a session whose client reports another Claude
// Code directory or memento config home is reading different layers, and a
// new directory is a new reading, since the project layer memento reads is
// anchored there.
const keyOf = (s: CeilingScope): string =>
  JSON.stringify([
    s.sessionId,
    s.projectDir,
    s.cwd,
    s.claudeConfigDir,
    s.env === undefined
      ? null
      : MEMENTO_ENV_VARS.map((v) => s.env?.[v] ?? null),
  ]);

// The bar's view of memento's context ceiling, per session: the reading each
// render shows, and the one way a click moves it.
//
// [LAW:single-enforcer] Reading and moving share this owner, so a move and the
// reading it makes stale cannot drift apart: a move supersedes the reading,
// so no render after it draws what memento said before it.
export class MementoProvider {
  private readonly readings: KeyedSource<CeilingScope, CeilingReading>;

  constructor(
    private readonly edge: MementoEdge,
    opts: { readonly logger?: DaemonLogger } = {},
  ) {
    this.readings = new KeyedSource({
      name: "memento",
      keyOf,
      fields: (s) =>
        `sid=${JSON.stringify(s.sessionId)} cwd=${JSON.stringify(s.cwd)}`,
      read: (scope) => {
        const located = edge.locate(scope);
        return located.kind === "ok"
          ? edge.read(located.value, scope)
          : Promise.resolve(located);
      },
      every: { okMs: READING_PERIOD_MS, failedMs: READING_PERIOD_MS },
      maxEntries: MAX_ENTRIES,
      logger: opts.logger ?? quietLogger,
    });
  }

  // absent — memento is not installed (or not enabled) for this project;
  // failed — memento refused (an unreadable layer: the very state that
  // switches its gate off). A python spawn does not fit in a render's budget,
  // so a render takes the stored reading and waits on one only where there
  // is none to take: a scope never read (a new session, or a new directory),
  // or one a move superseded.
  getCeiling(
    holds: Holds,
    scope: CeilingScope,
  ): Promise<Outcome<CeilingReading>> {
    return this.readings.read(holds, scope);
  }

  // [LAW:no-silent-failure] Memento absent is a refusal here, not a no-op: a
  // click that moved nothing must say so.
  move(scope: CeilingScope, m: CeilingMove): void {
    const located = this.edge.locate(scope);
    if (located.kind !== "ok") {
      throw new Error(
        located.kind === "failed"
          ? located.reason
          : "memento is not installed or not enabled for this project",
      );
    }
    try {
      this.edge.move(located.value, scope, m);
    } finally {
      // Superseded even when memento refused: the refusal may name a layer
      // that changed under it, which the next render should show as it now
      // stands.
      this.readings.supersede(scope);
    }
  }

  getStats(): KeyedSourceStats {
    return this.readings.stats();
  }

  close(): void {
    this.readings.close();
  }
}
