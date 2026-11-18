// [LAW:verifiable-goals] `cc-candybar doctor`: the doctor's second surface,
// and the agent-runnable one. It runs when no daemon does, because it exists
// to diagnose a cc-candybar that cannot start. Its exit code:
//   0: every check ok
//   1: at least one check failed (its reason on the line)
//   2: a usage error, or a run that could not report
//
// [LAW:single-enforcer] It is a host of its own bar, through the daemon's
// parts (src/daemon/local-bar.ts): the renderer in this process, a session
// opened here by the request a statusline client started here would send,
// and the doctor's click on it. The host's one reader of the doctor's facts
// (src/daemon/cache/doctor.ts) reads the machine for the run, the renderer
// judges it, and the report printed is the one its turn's record notes. No
// check is judged here, and no daemon is asked anything.

import { randomUUID } from "node:crypto";
import { openSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { WriteStream } from "node:tty";
import type { Host, World } from "../host.js";
import type { CliPlan } from "../cli-plan.js";
import { DOOR_GLYPH } from "../config/disclosure.js";
import { detectClientHints } from "../client-hints.js";
import { claudeConfigDir } from "../claude-settings.js";
import { previewSigner } from "../click/link-signer.js";
import {
  clickSessionOf,
  encodeSegments,
  VERB_DOCTOR_RUN,
} from "../click/wire.js";
import { discover, readShared } from "../daemon/config-discovery/discover.js";
import { daemonGates } from "../daemon/foundations/update-keys.js";
import { PROTOCOL_VERSION } from "../daemon/foundations/protocol.js";
import { plainEnvironment } from "../daemon/foundations/session-env.js";
import { MAIN_RENDERER } from "../daemon/foundations/renderer-name.js";
import { checkRenderRequest } from "../daemon/render-checkpoint.js";
import {
  daemonPaths,
  locations,
  profilePaths,
  stateDir,
} from "../daemon/paths.js";
import { HeldStores } from "../daemon/held-stores.js";
import { fileStorage } from "../daemon/file-storage.js";
import {
  commandDaemonFacts,
  localBar,
  type RendererBuilder,
} from "../daemon/local-bar.js";
import { createPayloadProviders } from "../daemon/payload-providers.js";
import { DoctorSource } from "../daemon/cache/doctor.js";
import { WatcherRegistry } from "../daemon/cache/watchers.js";
import { FileEventDelivery } from "../daemon/cache/file-events.js";
import { RefreshLedger } from "../utils/refresh-ledger.js";
import { runTeardown, type TeardownStep } from "../utils/teardown.js";
import { checkoutLocation } from "../utils/git-root.js";
import { instantAt } from "../utils/instant.js";
import type { DaemonLogger } from "../utils/logger.js";
import type { Launcher } from "../proc/launcher.js";
import { heardContextOf } from "../renderer-interface/request-context.js";
import {
  DOCTOR_NOTE,
  readDoctorNote,
  type NotedReport,
} from "../renderer-interface/noted-doctor.js";
import { NOT_HELD } from "./checks.js";
import type { DoctorMachineEdge } from "./ports.js";
import { productionMachineEdge } from "./edge.js";
import type { Sighted } from "./read.js";
import type { SightedBar } from "./sightings.js";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

// How long the bar's draw waits on its sources, as `check`'s does.
const SETTLE_MS = 2000;
// How long the run's reading may take: the machine's slowest probes (the
// terminal's font, Launch Services) each answer within seconds, and a run
// not reported by now is a failure to say.
const REPORT_MS = 20_000;

const FIX_HINT = ` (fix: click the settings menu (${DOOR_GLYPH} by default) › 🧰 tools › 🩺 doctor, then [fix] on the bar)`;

// The CLI has no bar to show glyphs in, so it cannot take a mark; it reads the
// marks made in the bar's doctor (the mark book), and points there.
const MARK_HINT = `mark them ✓ shapes or ✗ boxes in the bar's doctor, and this command reads your mark: the settings menu (${DOOR_GLYPH} by default) › 🧰 tools › 🩺 doctor`;

// A failed check's line, then one indented line per further problem it found,
// then what it asks the user to look at.
export function reportLine({ label, verdict }: NotedReport): string {
  return verdict.ok
    ? `✓ ${label}${verdict.note === undefined ? "" : ` — ${verdict.note}`}\n`
    : `✗ ${label} — ${verdict.reason}${verdict.fixable ? FIX_HINT : ""}\n` +
        verdict.more.map((problem) => `    ${problem}\n`).join("") +
        (verdict.look === undefined
          ? ""
          : `    look: ${verdict.look} — ${MARK_HINT}\n`);
}

export interface DoctorPlanInputs {
  readonly world: World;
  readonly cwd: string;
  // The file a session's statusline command names with `--config`.
  readonly configFile: string | undefined;
  // Measures the terminal the command runs in (`commandTerminal`).
  readonly measureTerminal: () => {
    readonly columns?: number;
    readonly rows?: number;
  };
  // [LAW:effects-at-boundaries] The machine as the doctor reads it, built as
  // the daemon builds it (`productionMachineEdge`), over one read's launcher.
  readonly edge: (
    launcher: Launcher,
    host: Host,
    stateDir: string,
  ) => DoctorMachineEdge;
  // What builds the renderer, unless a test wraps it.
  readonly build?: RendererBuilder;
  readonly reportMs?: number;
}

// [LAW:effects-at-boundaries] The whole CLI as data: the machine in, (streams,
// exit code) out. `doctorCommandPlan` hands it to the one delivery.
export async function doctorPlan(inputs: DoctorPlanInputs): Promise<CliPlan> {
  const closes: TeardownStep[] = [];
  const plan = await doctorRun(inputs, closes).catch(
    (e: unknown): CliPlan => ({
      stdout: "",
      stderr: `doctor: ${e instanceof Error ? e.message : String(e)}\n`,
      code: EXIT_USAGE,
    }),
  );
  // A one-shot run leaks no timer, watch or child past its report.
  // [LAW:no-silent-failure] A step that failed to close is the command's
  // failure, said beside its report.
  const torn: string[] = [];
  const failed = await runTeardown(closes, (_level, text) => {
    torn.push(`doctor: ${text}\n`);
  });
  return failed.length === 0
    ? plan
    : { ...plan, stderr: plan.stderr + torn.join(""), code: EXIT_USAGE };
}

// The run itself, each thing it opens pushed onto `closes`: throws when it
// could not report.
async function doctorRun(
  inputs: DoctorPlanInputs,
  closes: TeardownStep[],
): Promise<CliPlan> {
  const { world, cwd } = inputs;
  const { host, clock, launcher } = world;
  const quiet: DaemonLogger = () => {};
  // [LAW:one-source-of-truth] The hints a statusline client started here
  // would report, by the client's own detection, over the terminal the
  // command runs in.
  const hints = detectClientHints(host, cwd, inputs.measureTerminal());
  // The request a statusline client started here would send for a session
  // of its own: this directory, this shell's environment, and the config
  // file named on the command line. The session is new, so its bar is the
  // one a session opens on, and it has no transcript.
  const session = randomUUID();
  const checked = checkRenderRequest(
    {
      v: PROTOCOL_VERSION,
      kind: "render",
      hookData: {
        hook_event_name: "Status",
        session_id: session,
        cwd,
        transcript_path: path.join(
          host.tmp,
          `cc-candybar-doctor-${session}.jsonl`,
        ),
        model: { id: "", display_name: "" },
        workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
      },
      args: [
        "cc-candybar",
        ...(inputs.configFile === undefined
          ? []
          : ["--config", inputs.configFile]),
      ],
      cwd,
      encoding: "frame",
      env: plainEnvironment(host.env),
      ...hints,
    },
    { firstSightOfUnknownHookField: () => false },
    quiet,
    host.home,
  );
  if (!checked.ok)
    throw new Error(
      `the doctor's own request was refused: ${checked.problems.join("; ")}`,
    );
  const { req, environment } = checked;
  const origin = req.requested;
  // [LAW:single-enforcer] The daemon's discovery, at the origin the
  // request names.
  const { snapshot } = discover(
    {
      projectDir: origin.projectDir,
      configFile: origin.target.path,
      cwd: origin.cwd,
    },
    readShared({ locations: locations(host), stateDir: stateDir(host) }),
  );
  // [LAW:one-source-of-truth] The renderer's stores, read by the daemon's
  // own reader from the files the daemon keeps them in.
  const stores = new HeldStores(
    fileStorage(profilePaths(daemonPaths(host), MAIN_RENDERER), quiet, clock),
  );
  stores.load();
  // The bar this run judges is the one drawn here, once it is.
  let drawn: SightedBar | null = null;
  const sighted = (): Sighted => {
    if (drawn === null)
      throw new Error("the doctor's read came before its bar was drawn");
    return {
      serving: NOT_HELD,
      rateLimits: NOT_HELD,
      transcripts: NOT_HELD,
      clients: NOT_HELD,
      bars: [drawn],
      width: {
        kind: "ok",
        value: { columns: hints.termCols ?? null, of: { kind: "command" } },
      },
    };
  };
  const at = instantAt(clock);
  const bar = localBar({
    world,
    gates: daemonGates(),
    linkSigner: previewSigner(),
    stateDir: stateDir(host),
    home: host.home,
    locate: checkoutLocation,
    origin,
    snapshot,
    stored: stores.current(),
    // [LAW:single-enforcer] The daemon's own owners, built as it builds
    // them, with its one reader of the doctor's facts.
    owners: (sourceRuns, log) => {
      const ledger = new RefreshLedger(log);
      const watchers = new WatcherRegistry({ clock, logger: log });
      const doctor = new DoctorSource({
        edge: (signal) =>
          inputs.edge(
            {
              ...launcher,
              launch: (opts) => launcher.launch({ ...opts, signal }),
            },
            host,
            stateDir(host),
          ),
        sighted,
        clock,
        logger: log,
        ledger,
      });
      const providers = createPayloadProviders({
        launcher,
        host,
        watchers,
        fileEvents: new FileEventDelivery({ watchers, logger: log, clock }),
        clock,
        logger: log,
        ledger,
        sourceRuns,
        doctor,
      });
      closes.push(
        ...providers.closes,
        ["doctor close", () => doctor.close()],
        ["watchers close", () => watchers.closeAll()],
      );
      return providers;
    },
    daemon: () => commandDaemonFacts(at),
    build: inputs.build,
  });
  // The bar closes first: what it drew with closes after it.
  closes.unshift(["bar close", () => bar.close()]);
  const { answer } = await bar.draw(
    req,
    environment,
    clock.monotonic() + SETTLE_MS,
  );
  drawn = {
    role: "statusline",
    frame: answer.seen,
    projectDir: origin.projectDir,
    claudeConfigDir: claudeConfigDir(hints.claudeConfigDir, host.home),
  };
  // Waited on before the click, so no turn after it is missed.
  const reportMs = inputs.reportMs ?? REPORT_MS;
  const noted = bar.noted(DOCTOR_NOTE, clock.monotonic() + reportMs);
  const value = encodeSegments([session]);
  const clicked = await bar.click({
    kind: "click",
    verb: VERB_DOCTOR_RUN,
    value,
    session: clickSessionOf(VERB_DOCTOR_RUN, value),
    arrival: { via: "command" },
    context: heardContextOf(req),
  });
  if (clicked.kind === "threw")
    throw new Error(`the doctor's run failed: ${clicked.failure.message}`);
  const note = await noted;
  // [LAW:no-silent-failure] A run that reported nothing is the run's
  // failure, with whatever the bar logged on the way.
  if (note === null)
    throw new Error(
      [`no report within ${reportMs / 1000}s`, ...bar.errors()].join("\n"),
    );
  const run = readDoctorNote(note);
  if (run.kind === "failed")
    throw new Error(`the doctor's run failed: ${run.reason}`);
  const { reports } = run;
  return {
    stdout: reports.map(reportLine).join(""),
    stderr: "",
    code: reports.every((r) => r.verdict.ok) ? EXIT_OK : EXIT_FAILED,
  };
}

// The terminal the command runs in, which the bar of a Claude Code started
// here would be drawn in: its stderr, else (`2>&1 | tee`, `2>/dev/null`) its
// controlling terminal. A process that cannot open one (none at all, ENXIO,
// an agent's tool shell; none in its container, ENOENT; or one a sandbox
// refuses, EACCES) has no terminal to measure, which is the width row's
// failure, not the run's: every other check still has its facts.
function commandTerminal(): { readonly columns?: number } {
  if (process.stderr.isTTY) return process.stderr;
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return {};
  }
  const tty = new WriteStream(fd);
  const { columns } = tty;
  tty.destroy();
  return { columns };
}

// [LAW:parse-dont-validate] argv crosses one checkpoint and becomes a request,
// as `check`'s does, so the usage contract is a value a test reads rather
// than an exit from the middle of the command.
export type DoctorArgs =
  | { readonly kind: "run"; readonly configFile: string | undefined }
  | { readonly kind: "usage"; readonly message: string };

const USAGE = "Usage: cc-candybar doctor [config-file]\n";

export function parseDoctorArgs(args: readonly string[]): DoctorArgs {
  // [LAW:no-silent-failure] An option is named as one wherever it stands,
  // as `check` names its unknown options: read as a file, or refused as a
  // second file, it would be reported as something it is not.
  const options = args.filter((a) => a.startsWith("--"));
  const paths = args.filter((a) => !a.startsWith("--"));
  if (options.length > 0) {
    return {
      kind: "usage",
      message: `doctor: unknown option ${options.join(" ")}\n${USAGE}`,
    };
  }
  // [LAW:single-enforcer] Arity only. What the path means, including that
  // an empty one (a statusline's `--config "$CFG"` with CFG unset) is no
  // override, is the render checkpoint's to say, the one reading the bar
  // renders under.
  if (paths.length > 1) {
    return {
      kind: "usage",
      message: `doctor: expected at most one config file\n${USAGE}`,
    };
  }
  return { kind: "run", configFile: paths[0] };
}

// `cc-candybar doctor [config-file]`, the argv binding. The one argument is
// the config file a session's statusline command names with `--config`, so
// the CLI can check the file that session's bar renders.
export async function doctorCommandPlan(
  args: readonly string[],
  world: World,
): Promise<CliPlan> {
  const parsed = parseDoctorArgs(args);
  return parsed.kind === "usage"
    ? { stdout: "", stderr: parsed.message, code: EXIT_USAGE }
    : await doctorPlan({
        world,
        cwd: process.cwd(),
        configFile: parsed.configFile,
        measureTerminal: commandTerminal,
        edge: productionMachineEdge,
      });
}
