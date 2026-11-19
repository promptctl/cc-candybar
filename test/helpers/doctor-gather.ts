// The doctor's facts and fixes as one call, for a test that judges them apart
// from the click that asks for them: composed of the very pieces a run is made
// of — the ask its config makes (`doctorAsk`), the host's read of the machine
// (`readDoctor`), the composition (`doctorFacts`) — and a fix landed as the
// host lands one: the guarded change `settingChange` makes, through the
// host's own interpreter, onto a file the reading handed in.

import { readSettingsChain } from "../../src/claude-settings-read";
import type { RenderOrigin } from "../../src/config-hint";
import { performChanges } from "../../src/daemon/effect-interpreter";
import { NO_CONFIGS } from "./renderers";
import type { ClientHints } from "../../src/daemon/foundations/protocol";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import type { StoresRead } from "../../src/daemon/foundations/stats-snapshot";
import type {
  Asked,
  DoctorFacts,
  Fix,
  SettingsChain,
} from "../../src/doctor/checks";
import {
  asked,
  doctorAsk,
  doctorFacts,
  readSources,
  readThrough,
  settingChange,
  writableSettingsFiles,
} from "../../src/doctor/gather";
import type {
  ConfigLoad,
  DoctorEdge,
  DoctorStores,
} from "../../src/doctor/ports";
import { readDoctor, type Sighted } from "../../src/doctor/read";
import { instantOf } from "../../src/utils/instant";
import type { Field } from "../../src/utils/logfmt";
import {
  readDoctorRun,
  type DoctorReadInput,
} from "../../src/daemon/cache/doctor";
import type { DoctorRuns } from "../../src/renderer/doctor";
import { nextRunName, type DoctorRead } from "../../src/doctor/gather";
import { ofRun } from "../../src/daemon/readings";
import { NOT_HELD } from "../../src/doctor/checks";

// The run a gather outside any renderer reads as: one name, minted once.
const RUN = nextRunName(instantOf(new Date(0)), null);

// The machine's edge and the config a test's run judges.
export type GatherEdge = DoctorEdge & {
  readonly loadConfig: (origin: RenderOrigin) => ConfigLoad;
};

// The facts a run of `load` reads over `edge`, told `sighted` of the
// session's bars, but the URL handler's and the install's, which a test sets
// itself.
export async function gatherFacts(
  edge: GatherEdge,
  hints: Pick<ClientHints, "tmux" | "claudeConfigDir" | "terminalEnv" | "ssh">,
  origin: RenderOrigin,
  sessionPick: (key: string) => string | null,
  sighted: Sighted,
  stores: StoresRead,
): Promise<Omit<DoctorFacts, "urlHandler" | "install">> {
  const load = edge.loadConfig(origin);
  const machine = await readDoctor(
    edge,
    hints,
    doctorAsk(RUN, load, sessionPick, { via: "command" }),
    { cwd: origin.cwd, projectDir: origin.projectDir },
    sighted,
  );
  const {
    urlHandler: _u,
    install: _i,
    ...facts
  } = doctorFacts(
    { run: RUN, kind: "read", machine, install: NOT_HELD },
    load,
    origin.target,
    stores,
    { via: "command" },
  );
  return facts;
}

const SESSION = "doctor-fix-session" as SessionId;

// A fix applied as a click's lands: a settings fix through the host's
// interpreter, onto a file the reading handed in, and the post-mortems read
// filed in the store. The facts come back with every chain read again, or the
// reason the fix did not land.
export function applyFix(
  stores: DoctorStores,
  fix: Fix,
  facts: DoctorFacts,
): Asked<DoctorFacts> {
  switch (fix.kind) {
    case "claude-settings": {
      const landed = performChanges(
        [
          {
            kind: "change",
            id: 1 as never,
            session: SESSION,
            target: { kind: "claude-settings", file: fix.file.path },
            changes: [settingChange(fix, readSources(facts.claudeSettings))],
          },
        ],
        null,
        () =>
          writableSettingsFiles({
            run: RUN,
            kind: "read",
            machine: facts,
            install: facts.install,
          }),
        NO_CONFIGS,
      );
      if (landed.kind !== "ok")
        return { kind: "failed", reason: landed.reason };
      const reread = (chain: SettingsChain): SettingsChain => ({
        ...chain,
        sources: asked(() => readSettingsChain(chain.at)),
      });
      const { origin, elsewhere } = facts.claudeSettings;
      return {
        kind: "ok",
        value: {
          ...facts,
          claudeSettings: {
            origin: reread(origin),
            elsewhere: elsewhere.map(reread),
          },
        },
      };
    }
    case "post-mortems-read": {
      const read = stores.postMortemsRead.update(readThrough(fix.through));
      return read.kind === "failed"
        ? read
        : {
            kind: "ok",
            value: { ...facts, daemon: { ...facts.daemon, read } },
          };
    }
  }
}

// The host's side of a test's doctor runs: at the end of a turn, each run the
// renderer's doctor subscribes to is read by the daemon's own read and handed
// back as the session's world state carries it; the settings files a fix may
// write are the ones the latest reading named, as the collector's are.
export class DoctorHost {
  private readonly readings = new Map<SessionId, DoctorRead>();
  // The record of every turn a reading was taken in, as the renderer noted
  // it.
  readonly taken: Field[] = [];

  constructor(
    private readonly deps: Parameters<typeof readDoctorRun>[0],
    // What the session's newest request reported: its hints, and where it
    // runs.
    private readonly request: (
      session: SessionId,
    ) => Pick<DoctorReadInput, "hints" | "origin">,
  ) {}

  async settle(
    runs: Pick<DoctorRuns, "subscriptions" | "took">,
  ): Promise<void> {
    for (const [session, subscription] of runs.subscriptions()) {
      if (subscription.kind !== "doctor") continue;
      // Attributed to its run as the host's doctor lane attributes it.
      const doctor = ofRun(
        subscription.ask,
        await readDoctorRun(this.deps, {
          session,
          ...this.request(session),
          ask: subscription.ask,
        }),
      );
      if (doctor.kind === "ok" && doctor.value.kind === "read")
        this.readings.set(session, doctor.value);
      runs.took(
        { session, doctor: { ...doctor, at: instantOf(new Date()) } },
        this.taken,
      );
      // A run taken, or failed, asks for its reading no more.
      if (runs.subscriptions().has(session))
        throw new Error(
          `session ${session} still asks for run ${subscription.ask.run}`,
        );
    }
  }

  writable(session: SessionId): readonly string[] {
    const reading = this.readings.get(session);
    return reading === undefined ? [] : writableSettingsFiles(reading);
  }
}
