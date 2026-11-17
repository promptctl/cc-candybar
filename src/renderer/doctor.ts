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
import {
  doctorAsk,
  doctorFacts,
  readStores,
  type DoctorAsk,
  type DoctorReading,
} from "../doctor/gather";
import type { ConfigLoad, DoctorStores } from "../doctor/ports";
import { runDoctor, type DoctorFacts } from "../doctor/checks";
import { clickArrived, type ClickArrival } from "../doctor/sightings";
import { sightingOf } from "../doctor/terminal";
import { withClicked } from "../doctor/clicked-terminals";
import {
  configFields,
  daemonFields,
  dataFields,
  doctorReportPairs,
  frameFields,
  installFields,
  linkFields,
  nerdFontFields,
  terminalFeatureFields,
  transcriptFields,
  truecolorEnvFields,
} from "../doctor/report";

type Log = (level: "info" | "warn" | "error", msg: string) => void;

// One run of a session's doctor: what it asked, what it judges, how its click
// arrived, and the host's reading once it is in.
interface Run {
  readonly ask: DoctorAsk;
  readonly load: ConfigLoad;
  readonly target: ConfigTarget;
  readonly arrival: ClickArrival;
  reading: Extract<DoctorReading, { kind: "read" }> | null;
}

// What a run is asked with: the config load it judges, captured by the click
// that asked it, and where the session runs.
export interface RunRequest {
  readonly load: ConfigLoad;
  readonly target: ConfigTarget;
  readonly origin: DoctorAsk["origin"];
  readonly pick: (key: string) => string | null;
  readonly arrival: ClickArrival;
}

export interface DoctorRunsDeps {
  readonly sessionState: SessionStateRW;
  readonly stores: DoctorStores;
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
  // host reads afresh.
  start(session: SessionId, request: RunRequest): void {
    this.runs.set(session, {
      ask: doctorAsk(++this.last, request.load, request.pick, request.origin, {
        kind: "clicked",
        sessionId: session,
        via: request.arrival.via,
      }),
      load: request.load,
      target: request.target,
      arrival: request.arrival,
      reading: null,
    });
  }

  // Whether the session has a run, read or still on its way.
  running(session: SessionId): boolean {
    return this.runs.has(session);
  }

  // [LAW:one-source-of-truth] What each session's run asks the host to read:
  // held as long as the run, so its reading stays in the session's world
  // state, which names the settings files a fix may write.
  subscriptions(): ReadonlyMap<SessionId, Subscription> {
    return new Map(
      [...this.runs].map(([session, { ask }]) => [
        session,
        { kind: "doctor", ask },
      ]),
    );
  }

  // A world state taken: the first that carries the reading of its session's
  // run writes the run's report, or shows why the reading failed.
  took({ session, doctor }: Pick<WorldState, "session" | "doctor">): void {
    const run = this.runs.get(session);
    if (
      run === undefined ||
      run.reading !== null ||
      doctor.kind !== "ok" ||
      doctor.value.run !== run.ask.run
    )
      return;
    const reading = doctor.value;
    if (reading.kind === "failed") {
      this.runs.delete(session);
      this.deps.failed(session, `doctor: ${reading.reason}`);
      return;
    }
    run.reading = reading;
    const facts = this.composed(run, reading);
    this.report(session, { ...facts, clicked: this.filed(run, facts) });
  }

  // [LAW:single-enforcer] The session's run's facts as they stand: its
  // reading, its load, and the stores as they hold now. Null while no
  // reading is in.
  facts(session: SessionId): DoctorFacts | null {
    const run = this.runs.get(session);
    const reading = run?.reading ?? null;
    return run === undefined || reading === null
      ? null
      : this.composed(run, reading);
  }

  // [LAW:single-enforcer] One write of the whole report, through setBatch —
  // the row cap flips, the reason and fixable land, in one reactive
  // transaction.
  report(session: SessionId, facts: DoctorFacts): void {
    const reports = runDoctor(facts);
    this.deps.sessionState.setBatch(session, doctorReportPairs(reports));
    this.deps.log(
      "info",
      `doctor: ${reports.map((r) => `${r.check.name}=${r.verdict.ok ? "ok" : `failed(${1 + (r.verdict.more?.length ?? 0)})`}`).join(" ")} ${configFields(facts.config)} ${nerdFontFields(facts.nerdFont, facts.marks)} ${linkFields(facts.terminal, facts.clicked)} ${terminalFeatureFields(facts.terminal, facts.width)} ${installFields(facts.install)} ${daemonFields(facts.daemon)} ${dataFields(facts.data)} ${transcriptFields(facts.transcripts)} ${frameFields(facts.frames, facts.claudeSettings)} ${truecolorEnvFields(facts.claudeSettings.origin.sources)} (session=${session})`,
    );
  }

  retire(session: SessionId): void {
    this.runs.delete(session);
  }

  private composed(
    run: Run,
    { machine, install }: NonNullable<Run["reading"]>,
  ): DoctorFacts {
    return doctorFacts(
      machine,
      install,
      run.load,
      run.target,
      readStores(this.deps.stores),
      clickArrived(run.arrival),
    );
  }

  // [LAW:one-source-of-truth] A run asked by a link is a link the session's
  // terminal drew and the user clicked, so it settles for good that this
  // terminal draws links: filed (src/doctor/clicked-terminals.ts) where
  // `cc-candybar doctor` — which cannot click — reads it. Nothing is filed
  // from a tmux status-line click (tmux ran it, no link), where nothing names
  // the terminal, or over a list that does not read (the store answers that
  // failure, which the run reports as its own).
  // [LAW:no-silent-failure] The filing rides along with the run it came with,
  // so a write that fails is logged — and the event's `clicked=no` shows
  // nothing was filed — while the run reports over the list as it was read.
  private filed(run: Run, facts: DoctorFacts): DoctorFacts["clicked"] {
    const { terminal, clicked } = facts;
    const sighting =
      terminal.kind === "seen" ? sightingOf(terminal.identified) : null;
    if (sighting === null || run.arrival.via !== "link") return clicked;
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
