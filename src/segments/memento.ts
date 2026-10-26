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
import { valueOf } from "../utils/logfmt.js";
import type { Lane } from "../utils/reading.js";

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
const envOf = (s: CeilingScope): ReadonlyArray<string | null> | null =>
  s.env === undefined ? null : MEMENTO_ENV_VARS.map((v) => s.env?.[v] ?? null);
const keyOf = (s: CeilingScope): string =>
  JSON.stringify([
    s.sessionId,
    s.projectDir,
    s.cwd,
    s.claudeConfigDir,
    envOf(s),
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
      // Every part of the key, so two entries' events tell apart.
      fields: (s) =>
        `sid=${valueOf(s.sessionId)} project=${valueOf(s.projectDir)} cwd=${valueOf(s.cwd)} configDir=${valueOf(s.claudeConfigDir)} env=${valueOf(JSON.stringify(envOf(s)))}`,
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
  // so a draw takes the stored reading; after a move it reads the ceiling as
  // not answered yet until memento answers.
  declare(holds: Holds, scope: CeilingScope): Lane<CeilingReading> {
    return this.readings.declare(holds, scope);
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
    // [LAW:one-source-of-truth] The keyed source's one supersede: pending from
    // before the command, no read stored while it runs, and one fresh read
    // once it returns — even when memento refused, since the refusal may name
    // a layer that changed under it, which the next render should show as it
    // now stands.
    const resume = this.readings.supersede(scope);
    try {
      this.edge.move(located.value, scope, m);
    } finally {
      resume();
    }
  }

  getStats(): KeyedSourceStats {
    return this.readings.stats();
  }

  close(): void {
    this.readings.close();
  }
}
