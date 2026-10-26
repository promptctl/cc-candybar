import type { Outcome } from "./outcome";
import { quietLogger, type DaemonLogger } from "./logger";

// What asks a source to read, one vocabulary for every source
// (design-docs/SOURCES-AND-FRAMES.md, "Refresh"): a key's first read, its
// period's tick, a change (a watched file, a key's input, a hold returning to
// an entry of a source with no period), a session's statusline request, or a
// supersede's resume (the daemon itself changed what the key reads).
export const REFRESH_TRIGGERS = [
  "first",
  "period",
  "change",
  "request",
  "supersede",
] as const;
export type RefreshTrigger = (typeof REFRESH_TRIGGERS)[number];

// Where a source's value lives: one home per key of its scope.
export type SourceScope =
  | "daemon"
  | "configDir"
  | "repo"
  | "directory"
  | "session"
  | "view"
  | "pane";

// [LAW:types-are-the-program] What a source is, to everything that counts or
// reports it: its name, its scope and its refresh — the triggers that make it
// read. Both are required, so no source records a refresh without saying
// where it lives and what can ask it to read; `Trigger` is the source's own
// vocabulary, so a refresh under a trigger it has no way to fire cannot be
// recorded.
export interface SourceDeclaration<Trigger extends RefreshTrigger> {
  readonly name: string;
  readonly scope: SourceScope;
  readonly refresh: readonly Trigger[];
}

// [LAW:verifiable-goals] What one source has done since the daemon started:
// its refreshes by the trigger that asked for each, how many failed, and how
// long the last one took (null before its first).
export interface SourceRecord {
  readonly name: string;
  readonly scope: SourceScope;
  readonly refreshes: Readonly<Partial<Record<RefreshTrigger, number>>>;
  readonly failures: number;
  readonly lastMs: number | null;
}

interface Tally {
  readonly name: string;
  readonly scope: SourceScope;
  readonly refreshes: Partial<Record<RefreshTrigger, number>>;
  failures: number;
  lastMs: number | null;
}

// [LAW:single-enforcer] The one record of every source's refreshes: each
// owner declares its sources here and records each refresh through the handle
// it gets back, so daemon-stats and the feed summary read one ledger, never a
// count per owner. Declarations of one name in one scope (a user `shell`
// variable in two configs) share one record.
export class RefreshLedger {
  private readonly tallies = new Map<string, Tally>();

  constructor(private readonly logger: DaemonLogger = quietLogger) {}

  declare<Trigger extends RefreshTrigger>(
    declaration: SourceDeclaration<Trigger>,
  ): Refreshes<Trigger> {
    const key = `${declaration.scope}/${declaration.name}`;
    const tally = this.tallies.get(key) ?? {
      name: declaration.name,
      scope: declaration.scope,
      refreshes: {},
      failures: 0,
      lastMs: null,
    };
    for (const trigger of declaration.refresh) tally.refreshes[trigger] ??= 0;
    this.tallies.set(key, tally);
    return new Refreshes(tally, this.logger);
  }

  // Every source declared, by scope then name.
  snapshot(): readonly SourceRecord[] {
    return [...this.tallies.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, t]) => ({ ...t, refreshes: { ...t.refreshes } }));
  }

  // Every source's refreshes summed by trigger: what the feed summary
  // compares across its window.
  totals(): Readonly<Record<RefreshTrigger, number>> {
    const sum = Object.fromEntries(
      REFRESH_TRIGGERS.map((t) => [t, 0]),
    ) as Record<RefreshTrigger, number>;
    for (const tally of this.tallies.values()) {
      for (const trigger of REFRESH_TRIGGERS) {
        sum[trigger] += tally.refreshes[trigger] ?? 0;
      }
    }
    return sum;
  }
}

// [LAW:nothing-unseen] Which refreshes are an event of their own. A request's
// are facts of its render event (`refreshed=`), the one event of that unit of
// work, so they write no line beside it; every other trigger's refresh is its
// own unit of work. A failed refresh writes its line whatever asked for it.
const OWN_EVENT: Readonly<Record<RefreshTrigger, boolean>> = {
  first: true,
  period: true,
  change: true,
  request: false,
  supersede: true,
};

// [LAW:one-source-of-truth] The one spelling of a source's refresh event and
// of the counts its record reports, whatever schedules its reads: a failed
// refresh logs at warn, once, so a read of the stored value never logs it
// again [LAW:no-silent-failure].
export class Refreshes<Trigger extends RefreshTrigger> {
  constructor(
    private readonly tally: Tally,
    private readonly logger: DaemonLogger,
  ) {}

  // This source's record as the ledger holds it: what its owner's own stats
  // report, a view of the one tally rather than a count of its own.
  record(): SourceRecord {
    return { ...this.tally, refreshes: { ...this.tally.refreshes } };
  }

  // `fields` is the refreshed entry's logfmt identity.
  recorded(
    fields: string,
    by: Trigger,
    outcome: Outcome<unknown>,
    took: number,
  ): void {
    this.tally.refreshes[by] = (this.tally.refreshes[by] ?? 0) + 1;
    this.tally.lastMs = took;
    if (outcome.kind === "failed") this.tally.failures++;
    const failure = outcome.kind === "failed";
    if (!failure && !OWN_EVENT[by]) return;
    const why = failure ? ` reason=${JSON.stringify(outcome.reason)}` : "";
    this.logger(
      failure ? "warn" : "info",
      `${this.tally.name} refresh ${fields} by=${by} outcome=${outcome.kind}${why} took=${took}ms`,
    );
  }
}
