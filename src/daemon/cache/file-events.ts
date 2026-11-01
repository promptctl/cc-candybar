import fs from "node:fs";
import path from "node:path";
import type { Invalidation, WatcherHandle, WatcherRegistry } from "./watchers";
import {
  sameIdentity,
  statIdentity,
  type FolderIdentity,
  type IdentityRead,
} from "../../utils/folder-identity";
import type { Release } from "../../utils/holds";
import type { DaemonLogger } from "../../utils/logger";
import { valueOf } from "../../utils/logfmt";

// [LAW:no-ambient-temporal-coupling] How often the owner writes a probe: a
// probe's event gets one full period, far above the watch's debounce.
export const PROBE_EVERY_MS = 30_000;
// How many probes in a row may go unreported before delivery is judged
// stalled. More than one, because libuv's macOS watch drops whatever lands
// while it rebuilds its one FSEvents stream, which any watch opening or
// closing anywhere in the daemon makes it do.
export const STALL_AFTER = 2;
// The file the owner rewrites in its folder to test its watch.
export const PROBE_FILE = "probe";

// [LAW:types-are-the-program] Whether the OS is delivering this daemon's file
// events. `delivering`: the times of the probes written since the watch last
// reported. `stalled`: STALL_AFTER probes in a row went unreported.
// `unmeasured`: the daemon cannot check, since a time and for a reason.
//
// `missedSince` is the start of the span in which the daemon cannot vouch
// that it heard every event: opened by a stall's first unreported probe or by
// a move into `unmeasured`, whichever comes first, carried through every
// later state, and closed only by an event the watch reports. Closing it is
// the catch-up, so the catch-up runs however the span ended. A stall always
// has one; only an owner never started is unmeasured without one.
export type Delivery =
  | {
      readonly kind: "delivering";
      readonly unreported: readonly number[];
      readonly missedSince: number | null;
    }
  | { readonly kind: "stalled"; readonly missedSince: number }
  | {
      readonly kind: "unmeasured";
      readonly since: number;
      readonly reason: string;
      readonly missedSince: number | null;
    };

// What subscribers are told: a period passed; delivery moved to another
// state; or a span closed, starting at `since`, in which an event may have
// gone unheard.
export type DeliveryNotice =
  | { readonly kind: "period" }
  | { readonly kind: "moved" }
  | { readonly kind: "caught-up"; readonly since: number };

export interface FileEventsStats {
  readonly delivery: Delivery;
  // Every move into a stall, every span closed, and the probes written and
  // failed.
  readonly stalls: number;
  readonly catchUps: number;
  readonly probes: number;
  readonly probeFailures: number;
}

// What a consumer of the one fact reads.
export type FileEvents = Pick<FileEventDelivery, "delivery" | "subscribe">;

// What a build outside the daemon reads: nothing measured, no span open, and
// no notice ever sent.
export const NO_FILE_EVENTS: FileEvents = {
  delivery: () => ({
    kind: "unmeasured",
    since: 0,
    reason: "outside the daemon",
    missedSince: null,
  }),
  subscribe: () => () => {},
};

// [LAW:types-are-the-program] The instrument itself: not started, probing its
// folder through its one watch, or ended, because its watch failed or its
// folder went. An ended instrument holds no watch, so nothing it could hear
// is ever judged; its period still runs, because subscribers keep time by it.
type Instrument =
  | { readonly kind: "idle" }
  | {
      readonly kind: "probing";
      readonly folder: string;
      readonly identity: FolderIdentity;
      readonly handle: WatcherHandle;
      readonly period: NodeJS.Timeout;
    }
  | { readonly kind: "ended"; readonly period: NodeJS.Timeout };

type Probing = Extract<Instrument, { kind: "probing" }>;

const iso = (at: number): string => new Date(at).toISOString();

// One state per label: a move is a change of label, so a second probe write
// failing for the same reason is not one.
const label = (d: Delivery): string =>
  d.kind === "unmeasured" ? `unmeasured:${d.reason}` : d.kind;

// [LAW:single-enforcer] The one owner of whether the OS is delivering this
// daemon's file events. The registry opens only directory watches, and libuv
// carries every directory watch in a process on one FSEvents stream (macOS)
// or one inotify instance whose overflow is shared (Linux), so delivery fails
// for the whole daemon at once, never for one folder: one fact, one owner.
//
// [LAW:nothing-unseen] A watch the OS has stopped feeding reports nothing,
// exactly as a folder nobody writes does. Only writing tells the two apart,
// so the owner writes a probe into a folder of its own each period: the
// config's folder is the user's, and a project's is a repository.
export class FileEventDelivery {
  private current: Delivery;
  private instrument: Instrument = { kind: "idle" };
  private readonly listeners = new Set<(notice: DeliveryNotice) => void>();
  private stalls = 0;
  private catchUps = 0;
  private probes = 0;
  private probeFailures = 0;
  private readonly watchers: WatcherRegistry;
  private readonly logger: DaemonLogger;
  private readonly identityOf: IdentityRead;

  constructor(opts: {
    readonly watchers: WatcherRegistry;
    readonly logger: DaemonLogger;
    readonly identityOf?: IdentityRead;
  }) {
    this.watchers = opts.watchers;
    this.logger = opts.logger;
    this.identityOf = opts.identityOf ?? statIdentity;
    // [LAW:no-silent-failure] Nothing reads as delivering before it has been
    // measured.
    this.current = {
      kind: "unmeasured",
      since: Date.now(),
      reason: "not started",
      missedSince: null,
    };
  }

  delivery(): Delivery {
    return this.current;
  }

  subscribe(listener: (notice: DeliveryNotice) => void): Release {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  // Only the daemon starts the owner, once it has won its socket: it makes
  // the folder, opens the one watch, and arms the period.
  start(folder: string): void {
    if (this.instrument.kind !== "idle") {
      throw new Error("file events: the owner was started twice");
    }
    const period = setInterval(() => void this.tick(), PROBE_EVERY_MS);
    period.unref();
    let identity: FolderIdentity | "gone";
    try {
      fs.mkdirSync(folder, { recursive: true });
      identity = this.identityOf(folder);
    } catch (e) {
      this.end(
        period,
        `the probe folder could not be made: ${(e as Error).message}`,
      );
      return;
    }
    if (identity === "gone") {
      this.end(period, "the probe folder was removed as it was made");
      return;
    }
    const probing: Probing = {
      kind: "probing",
      folder,
      identity,
      period,
      // [LAW:single-enforcer] The only acquirer of this registry key.
      handle: this.watchers.acquire(
        `file-events:${folder}`,
        { dirs: [{ path: folder, filenames: [PROBE_FILE] }] },
        (heard) => this.heard(probing, heard),
      ),
    };
    this.instrument = probing;
    this.logger("info", `file events probing folder=${valueOf(folder)}`);
    const [refusal] = probing.handle.deaf;
    if (refusal !== undefined) {
      this.end(
        period,
        `the OS refused the probe folder's watch: ${refusal.reason}`,
      );
      return;
    }
    this.move({ kind: "delivering", unreported: [], missedSince: null });
    void this.tick();
  }

  stats(): FileEventsStats {
    return {
      delivery: this.current,
      stalls: this.stalls,
      catchUps: this.catchUps,
      probes: this.probes,
      probeFailures: this.probeFailures,
    };
  }

  close(): void {
    const inst = this.instrument;
    this.instrument = { kind: "idle" };
    this.listeners.clear();
    switch (inst.kind) {
      case "probing":
        inst.handle.release();
        clearInterval(inst.period);
        return;
      case "ended":
        clearInterval(inst.period);
        return;
      case "idle":
        return;
    }
  }

  // [LAW:dataflow-not-control-flow] The same steps at the start and every
  // period after: tell subscribers the period passed; judge the probe folder
  // against the one the watch opened on, first, so a folder replaced at its
  // path never reads as a stall; judge the probes still unreported; write the
  // next one.
  private async tick(): Promise<void> {
    this.notify({ kind: "period" });
    const inst = this.instrument;
    if (inst.kind !== "probing") return;
    let now: FolderIdentity | "gone";
    try {
      now = this.identityOf(inst.folder);
    } catch (e) {
      this.end(
        inst.period,
        `the probe folder cannot be read: ${(e as Error).message}`,
      );
      return;
    }
    if (now === "gone") {
      this.end(inst.period, "the probe folder was removed");
      return;
    }
    if (!sameIdentity(now, inst.identity)) {
      this.end(inst.period, "the probe folder was replaced");
      return;
    }
    const d = this.current;
    if (d.kind === "delivering" && d.unreported.length >= STALL_AFTER) {
      this.stalls++;
      this.move({
        kind: "stalled",
        missedSince: d.missedSince ?? d.unreported[0]!,
      });
    }
    await this.probe(inst);
  }

  // A delivering watch awaits the probe; a stalled one awaits none in
  // particular, since any report recovers it. A write that lands while
  // unmeasured measures again, awaiting that probe, so a transient failure
  // (a full disk) measures once it clears. A write that fails is unmeasured
  // with its error: it tests no watch. A probe still in flight when the
  // instrument ends or closes judges nothing.
  private async probe(inst: Probing): Promise<void> {
    const at = Date.now();
    const before = this.current;
    if (before.kind === "delivering") {
      this.current = { ...before, unreported: [...before.unreported, at] };
    }
    try {
      await fs.promises.writeFile(
        path.join(inst.folder, PROBE_FILE),
        String(at),
      );
    } catch (e) {
      this.probeFailures++;
      const d = this.current;
      if (this.instrument !== inst || d.kind === "unmeasured") return;
      this.move({
        kind: "unmeasured",
        since: at,
        reason: `the probe could not be written: ${(e as Error).message}`,
        missedSince: d.missedSince ?? at,
      });
      return;
    }
    this.probes++;
    const d = this.current;
    if (this.instrument !== inst || d.kind !== "unmeasured") return;
    this.move({
      kind: "delivering",
      unreported: [at],
      missedSince: d.missedSince,
    });
  }

  // [LAW:no-silent-failure] The watch's own failure ends the instrument: the
  // OS refuses an immediate retry the way it refused the first (limits,
  // permissions). Anything else it reports proves delivery.
  private heard(inst: Probing, heard: Invalidation): void {
    if (this.instrument !== inst) return;
    if (heard.kind === "failed") {
      this.end(inst.period, `the probe folder's watch failed: ${heard.reason}`);
      return;
    }
    const d = this.current;
    const delivering: Delivery = {
      kind: "delivering",
      unreported: [],
      missedSince: null,
    };
    if (d.missedSince === null) {
      this.move(delivering);
      return;
    }
    this.current = delivering;
    this.catchUps++;
    this.logger(
      "info",
      `file events resumed since=${iso(d.missedSince)} missed=${Date.now() - d.missedSince}ms from=${d.kind}`,
    );
    this.notify({ kind: "caught-up", since: d.missedSince });
  }

  // [LAW:no-silent-failure] An ended instrument holds no watch and never
  // measures again, so whatever ended it, restarting is the way out.
  private end(period: NodeJS.Timeout, reason: string): void {
    const inst = this.instrument;
    if (inst.kind === "probing") inst.handle.release();
    this.instrument = { kind: "ended", period };
    const at = Date.now();
    this.move({
      kind: "unmeasured",
      since: at,
      reason: `${reason}; restart the daemon`,
      missedSince: this.current.missedSince ?? at,
    });
  }

  // [LAW:nothing-unseen] One line on each change of state, none per period.
  private move(next: Delivery): void {
    const was = label(this.current);
    this.current = next;
    if (label(next) === was) return;
    switch (next.kind) {
      case "delivering":
        this.logger("info", "file events delivering");
        break;
      case "stalled":
        this.logger(
          "warn",
          `file events stalled since=${iso(next.missedSince)}`,
        );
        break;
      case "unmeasured":
        this.logger(
          "warn",
          `file events unmeasured since=${iso(next.since)} reason=${JSON.stringify(next.reason)}`,
        );
        break;
    }
    this.notify({ kind: "moved" });
  }

  private notify(notice: DeliveryNotice): void {
    for (const listener of [...this.listeners]) listener(notice);
  }
}

const stopped = (since: number): string =>
  `file events stopped at ${iso(since)}; the OS has delivered none since, not even for a file the daemon wrote to test it`;

// [LAW:one-source-of-truth] Why nothing that refreshes on file events can
// refresh now, or `null` while delivery is not stalled: what each such
// consumer shows. Unmeasured is no finding about delivery, so it is not one
// here: those consumers read as usual, and the bar's row says it cannot check.
export const stallReason = (d: Delivery): string | null =>
  d.kind === "stalled" ? stopped(d.missedSince) : null;

// [LAW:no-silent-failure] The bar's row for as long as the span is open,
// whatever state delivery is in: an edit made after the span's start may never
// have been heard, and only an event the watch reports closes it. With no span
// open nothing can have gone unheard, so a delivering watch draws none, and
// neither does an owner never started: the page's simulated machine watches
// nothing an edit could depend on, and a test's daemon in a jest worker proves
// the watches it reads by a delivered event.
export interface FileEventsWarning {
  readonly kind: "file-events";
  readonly state: Delivery["kind"];
  readonly message: string;
}

export function fileEventsWarnings(d: Delivery): FileEventsWarning[] {
  if (d.missedSince === null) return [];
  const since = iso(d.missedSince);
  const message = (): string => {
    switch (d.kind) {
      case "delivering":
        return `file events unconfirmed since ${since}: the probe written to test them has not been heard yet, so an edit to the config made since may not have reloaded`;
      case "stalled":
        return `${stopped(d.missedSince)}, so an edit to the config will not reload until they resume`;
      case "unmeasured":
        return `the daemon cannot check whether file events are arriving: ${d.reason}, since ${since}`;
    }
  };
  return [{ kind: "file-events", state: d.kind, message: message() }];
}

// daemon-stats' `fileEvents` line: the state, then the span's start whenever
// one is open, the same instant the bar's row names.
export function fileEventsLine(s: FileEventsStats): string {
  const { delivery: d } = s;
  const state =
    d.kind === "unmeasured"
      ? `unmeasured since ${iso(d.since)} reason=${JSON.stringify(d.reason)}`
      : d.kind;
  const span =
    d.missedSince === null ? "" : ` unvouched since ${iso(d.missedSince)}`;
  return `${state}${span} stalls=${s.stalls} catchUps=${s.catchUps} probes=${s.probes} probeFailures=${s.probeFailures}`;
}
