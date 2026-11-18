// [LAW:single-enforcer] The renderer's doctor runs: each session's one run —
// what it asks the host to read of the machine, and the config load it judges
// — and the report written once the host's reading of it arrives in the
// session's world state (docs/design/host-and-renderer.md §7). The renderer
// reads no Claude Code settings and spawns no probe: the facts it judges are
// the host's reading, the load the run was asked for, and the doctor's stores.
//
// [LAW:no-ambient-temporal-coupling] A run lives in memory only: a renderer
// that starts again holds none, so no session re-probes the machine because a
// doctor once ran in it. A fix or mark click with no reading in hand starts a
// run and asks for the click again.

import type { SessionId } from "../daemon/foundations/session-id";
import type { WorldState } from "../facts/world-state";
import type { Subscription } from "../renderer-interface/interface";
import type { SessionStateRW } from "../renderer-interface/session-state";
import type { ConfigTarget } from "../config-hint";
import type { Instant } from "../utils/instant";
import {
  doctorAsk,
  doctorFacts,
  readStores,
  type DoctorAsk,
  type DoctorRead,
} from "../doctor/gather";
import type { ConfigLoad, DoctorDocuments } from "../doctor/ports";
import { CHECKS, runDoctor, type DoctorFacts } from "../doctor/checks";
import type { ClickArrival } from "../doctor/sightings";
import { sightingOf } from "../doctor/terminal";
import { withClicked } from "../doctor/clicked-terminals";
import {
  doctorFields,
  doctorReportKeys,
  doctorReportPairs,
  notedReports,
  VERDICT_UNRUN,
} from "../doctor/report";
import { DOCTOR_NOTE, doctorNote } from "../renderer-interface/noted-doctor";
import {
  noteFacts,
  type RequestFacts,
} from "../daemon/foundations/request-event";

type Log = (level: "info" | "warn" | "error", msg: string) => void;

// One run of a session's doctor: what it asked, what it judges, how its click
// arrived, and the host's reading once it is in, with when it landed.
interface Run {
  readonly ask: DoctorAsk;
  readonly load: ConfigLoad;
  readonly target: ConfigTarget;
  readonly arrival: ClickArrival;
  reading: { readonly read: DoctorRead; readonly at: Instant } | null;
}

// How long a reading answers a click on its report. A reading names the
// terminal that drew the bar when it was read, and a mark or a link click is
// filed under that terminal for good, so a click judges only a reading as
// recent as the report the user is answering; an older one is read again.
const FRESH_FOR = 120;

// Every check's row gated off: its verdict back to unrun.
const UNRUN = CHECKS.map((check) => ({
  key: doctorReportKeys(check.name).verdict,
  value: VERDICT_UNRUN,
}));

// What a run is asked with: the config load it judges, captured by the click
// that asked it.
export interface RunRequest {
  // When the click that asked it ran.
  readonly at: Instant;
  readonly load: ConfigLoad;
  readonly target: ConfigTarget;
  readonly pick: (key: string) => string | null;
  readonly arrival: ClickArrival;
}

export interface DoctorRunsDeps {
  // Where a reading's report is written as it arrives, outside any click.
  readonly sessionState: SessionStateRW;
  readonly stores: DoctorDocuments;
  readonly log: Log;
  // [LAW:no-silent-failure] A run whose reading failed shows why on its
  // session's bar, as a click's own failure does.
  readonly failed: (session: SessionId, reason: string) => void;
}

export class DoctorRuns {
  private readonly runs = new Map<SessionId, Run>();
  private last = 0;

  constructor(private readonly deps: DoctorRunsDeps) {}

  // A new run of the session, replacing the one it held: a new ask, which the
  // host reads afresh. [LAW:one-source-of-truth] A run is named by the
  // millisecond its click ran, kept rising, so a renderer that starts again
  // names no run an earlier one asked: the host may still hold that run's
  // reading, which would be taken for the new run's. The report the run
  // replaces goes from `store`, the click's view, with it: no verdict or
  // [fix] stands for a run no longer the session's.
  start(store: SessionStateRW, session: SessionId, request: RunRequest): void {
    store.setBatch(session, UNRUN);
    this.last = Math.max(Math.round(request.at * 1000), this.last + 1);
    this.runs.set(session, {
      ask: doctorAsk(this.last, request.load, request.pick, request.arrival),
      load: request.load,
      target: request.target,
      arrival: request.arrival,
      reading: null,
    });
  }

  // Whether the session's run is on its way: asked, its reading not in.
  awaiting(session: SessionId): boolean {
    return this.runs.get(session)?.reading === null;
  }

  // [LAW:one-source-of-truth] What each session's unread run asks the host to
  // read: held until its reading is in, which the run then keeps, so no world
  // state after it carries the reading again.
  subscriptions(): ReadonlyMap<SessionId, Subscription> {
    return new Map(
      [...this.runs].flatMap(([session, { ask, reading }]) =>
        reading === null ? [[session, { kind: "doctor", ask }] as const] : [],
      ),
    );
  }

  // A world state taken: the first that carries the reading of its session's
  // unread run writes the run's report, or shows why the run was not read.
  // The run is read once its report is written: one that could not be
  // written fails the run, with the reason on the bar. The report is noted on
  // `record`, the record of the turn that took the world state.
  took(
    { session, doctor }: Pick<WorldState, "session" | "doctor">,
    record: RequestFacts,
  ): void {
    const run = this.runs.get(session);
    if (
      run === undefined ||
      run.reading !== null ||
      doctor.kind !== "ok" ||
      doctor.value.run !== run.ask.run
    )
      return;
    const reading = doctor.value;
    if (reading.kind === "failed") return this.fail(session, reading.reason);
    try {
      this.report(
        this.deps.sessionState,
        session,
        this.judged(run, reading, run.arrival),
        record,
      );
      run.reading = { read: reading, at: doctor.at };
    } catch (e) {
      this.fail(session, e instanceof Error ? e.message : String(e));
    }
  }

  // [LAW:single-enforcer] The session's run's facts as they stand for a click
  // at `now` that arrived as `arrival`: its reading, its load, the stores as
  // they hold now, and what the click proves of the URL handler. Null while
  // no reading is in, or none read in the last FRESH_FOR seconds.
  facts(
    session: SessionId,
    arrival: ClickArrival,
    now: Instant,
  ): DoctorFacts | null {
    const run = this.runs.get(session);
    const reading = run?.reading ?? null;
    return run === undefined || reading === null || now - reading.at > FRESH_FOR
      ? null
      : this.judged(run, reading.read, arrival);
  }

  // [LAW:single-enforcer] One write of the whole report, through setBatch —
  // the row cap flips, the reason and fixable land, in one reactive
  // transaction — into `store`: a click's journaled view, so the report is
  // one with the rest of its click, or the session state a reading lands in.
  // [LAW:nothing-unseen] The turn's record carries every verdict whole and
  // what the run reasoned over, so a reader of the record (the host's log,
  // `cc-candybar doctor`) has the report the rows were written from.
  report(
    store: SessionStateRW,
    session: SessionId,
    facts: DoctorFacts,
    record: RequestFacts,
  ): void {
    const reports = runDoctor(facts);
    store.setBatch(session, doctorReportPairs(reports));
    noteFacts(record, { [DOCTOR_NOTE]: doctorNote(notedReports(reports)) });
    record.push(...doctorFields(facts));
  }

  retire(session: SessionId): void {
    this.runs.delete(session);
  }

  private fail(session: SessionId, reason: string): void {
    this.runs.delete(session);
    this.deps.failed(session, `doctor: ${reason}`);
  }

  private judged(
    run: Run,
    read: DoctorRead,
    arrival: ClickArrival,
  ): DoctorFacts {
    const facts = doctorFacts(
      read,
      run.load,
      run.target,
      readStores(this.deps.stores),
    );
    return { ...facts, clicked: this.filed(arrival, facts) };
  }

  // [LAW:one-source-of-truth] A click that arrived by a link is a link the
  // session's terminal drew and the user clicked, so it settles for good that
  // this terminal draws links: filed (src/doctor/clicked-terminals.ts) where
  // `cc-candybar doctor` — which cannot click — reads it. Nothing is filed
  // from a tmux status-line click (tmux ran it, no link), where nothing names
  // the terminal, or over a list that does not read (the store answers that
  // failure, which the run reports as its own).
  // [LAW:no-silent-failure] The filing rides along with the click it came
  // with, so a write that fails is logged — and the event's `clicked=no`
  // shows nothing was filed — while the run reports over the list as read.
  private filed(
    arrival: ClickArrival,
    facts: DoctorFacts,
  ): DoctorFacts["clicked"] {
    const { terminal, clicked } = facts;
    const sighting =
      terminal.kind === "seen" ? sightingOf(terminal.identified) : null;
    if (sighting === null || arrival.via !== "link") return clicked;
    try {
      return this.deps.stores.clicked.update((list) =>
        withClicked(list, sighting),
      );
    } catch (e) {
      this.deps.log(
        "warn",
        `doctor: clicked terminal not filed for ${JSON.stringify(sighting)}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return clicked;
    }
  }
}
