// Minimal end-to-end demo of the segment DSL render spine.
//
//   pnpm demo                                # renders src/demo/statusline.json5
//   pnpm demo path/to/other.json5            # renders any DSL config
//   pnpm demo --recording bar.jsonl [cfg]    # replays `cc-candybar record`'s file
//
// pnpm runs scripts from the repo root, so a relative path resolves there,
// not in the directory you typed the command in.
//
// This is the demo's process main: it reads the machine and its arguments
// once and hands values to the one view-and-print path (src/demo/play.ts).
//
// [LAW:dataflow-not-control-flow] `--recording` chooses values, never a second
// path: which facts arm the view follows (the in-process arm over the
// providers, or the recording's), which requests it is drawn by and when (one
// faked hook event four times, or the recording's requests at their offsets),
// and how each arrives (a sleep and the clock's reading, or a held clock's
// advance and the recorded instant).
// Rendering N frames over time is not branching: it lets the config's own
// timed sources populate, as the daemon re-renders on each status-line tick.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { sleep } from "../time.js";
import { instantAt } from "../utils/instant.js";
import { detectClientHints } from "../client-hints.js";
import {
  ConfigError,
  DroppedPlacements,
} from "../config/loader/diagnostics.js";
import { WatcherRegistry } from "../daemon/cache/watchers.js";
import { NO_FILE_EVENTS } from "../daemon/cache/file-events.js";
import { cacheDir, stateDir } from "../daemon/paths.js";
import { linkKeyFile, linkSignerFromKeyFile } from "../daemon/link-key.js";
import type { DaemonLogger } from "../utils/logger.js";
import { createPayloadProviders } from "../daemon/payload-providers.js";
import { processWorld, type World } from "../host.js";
import { heldClock } from "../held-clock.js";
import { livePricing } from "../segments/pricing.js";
import { RefreshLedger } from "../utils/refresh-ledger.js";
import { SourceRuns } from "../var-system/source-runs.js";
import { parseClientHints } from "../daemon/protocol.js";
import { inProcessFacts, recordingFacts } from "../daemon/facts-source.js";
import { sessionIdOf } from "../daemon/session-id.js";
import { newUpdateFact } from "../daemon/update-fact.js";
import { ansiOf } from "../render/frame.js";
import type { ClaudeHookData } from "../utils/claude.js";
import { debug, setDebug } from "../utils/logger.js";
import {
  heldArrival,
  loadDemo,
  NEVER_CLICKED,
  playDemo,
  playOf,
  readRecording,
  RecordingUnreadable,
  type DemoPlay,
} from "./play.js";

const FRAMES = 4;
const FRAME_INTERVAL_MS = 450;

const here = dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();

// Arguments the demo cannot run with: the message is the whole report.
class UsageError extends Error {}

// [LAW:parse-dont-validate] The arguments, read once: a config path, and a
// recording to replay. Anything else is refused by name.
function parseArgs(args: readonly string[]): {
  readonly configPath: string;
  readonly recording: string | null;
} {
  let config: string | null = null;
  let recording: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--recording") {
      const path = args[++i];
      if (path === undefined) throw new UsageError("--recording needs a path");
      recording = resolve(path);
    } else if (arg === undefined || arg.startsWith("-") || config !== null) {
      throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
    } else {
      config = resolve(arg);
    }
  }
  return {
    configPath: config ?? join(here, "statusline.json5"),
    recording,
  };
}

// [LAW:effects-at-boundaries] This script is its own process main: it reads the
// machine once, as src/index.ts does, and the debug channel follows it.
const machine = processWorld();
setDebug(Boolean(machine.host.env.CC_CANDYBAR_DEBUG));

// [LAW:no-silent-failure] What the daemon writes to daemon.log, the demo says
// on stderr when it is a problem; the daemon's routine lines stay behind
// CC_CANDYBAR_DEBUG. The demo never writes the daemon's own log file.
const log: DaemonLogger = (level, message) =>
  level === "info"
    ? debug(message)
    : void process.stderr.write(`${level}: ${message}\n`);

// What the frames are drawn from beside the loaded config, and what to close
// once they are drawn.
type Arm = Pick<DemoPlay, "facts" | "clock" | "steps" | "arrive" | "home"> & {
  readonly world: World;
  readonly close: () => void;
};

// One Claude Code hook event, faked, drawn four times on the machine's clock,
// its facts read by the owners the daemon builds. A session that has never
// run has no transcript, so the path names no file — a missing transcript is
// an empty session, not a failure.
function liveArm(): Arm {
  const sessionId = sessionIdOf("demo0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b");
  const hookData: ClaudeHookData = {
    hook_event_name: "Status",
    session_id: sessionId,
    transcript_path: join(
      machine.host.tmp,
      `cc-candybar-demo-${sessionId}.jsonl`,
    ),
    cwd,
    model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
    workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
  };
  // The demo's frames go to stdout, so stdout is the stream on the terminal.
  const hints = parseClientHints(
    detectClientHints(machine.host, cwd, process.stdout),
  );
  const watchers = new WatcherRegistry({ clock: machine.clock, logger: log });
  // Ended by the arm's close, with the providers it prices for.
  const pricingClosing = new AbortController();
  const providers = createPayloadProviders({
    launcher: machine.launcher,
    host: machine.host,
    pricing: livePricing({
      cacheRoot: cacheDir(machine.home),
      clock: machine.clock,
      closing: pricingClosing.signal,
      log,
    }),
    watchers,
    // The demo holds no folder and watches nothing.
    fileEvents: NO_FILE_EVENTS,
    clock: machine.clock,
    logger: log,
    ledger: new RefreshLedger(log),
  });
  // The demo runs no update watch: its facts document carries an update
  // nothing has sampled.
  const updateFact = newUpdateFact();
  // [LAW:single-enforcer] The arm's one owner of the config's sources' runs,
  // closed with it.
  const runs = new SourceRuns({
    launcher: machine.launcher,
    clock: machine.clock,
    logger: log,
    watchers,
  });
  const request = { sessionId, hookData, cwd, hints };
  // Each request, then the draw of its answer once what it started landed.
  const arrives = (i: number) =>
    ({ kind: "request", offsetMs: i * FRAME_INTERVAL_MS, request }) as const;
  const answered = (i: number) =>
    ({
      kind: "draw",
      requestOffsetMs: i * FRAME_INTERVAL_MS,
      state: NEVER_CLICKED,
    }) as const;
  return {
    world: machine,
    facts: inProcessFacts({
      providers,
      update: () => updateFact.get(),
      runs,
    }),
    clock: machine.clock,
    home: machine.host.home,
    steps: [
      arrives(0),
      answered(0),
      ...Array.from({ length: FRAMES - 1 }, (_, i) => [
        arrives(i + 1),
        answered(i + 1),
      ]).flat(),
    ],
    // [LAW:no-ambient-temporal-coupling] A sleep until the request's offset,
    // never for the gap since the last one, so a slow settle delays one frame
    // and no frame after it; and the instant is the clock's reading, as the
    // daemon reads a request's arrival.
    arrive: async (atMs) => {
      await sleep(machine.clock, Math.max(0, atMs - machine.clock.now()));
      return instantAt(machine.clock);
    },
    // The providers own their timers and watchers; all of them are released
    // so the process ends when the frames do.
    close: () => {
      pricingClosing.abort(new Error("the demo closed"));
      runs.close();
      providers.gitProvider.close();
      providers.usageStore.close();
      providers.tmuxService.close();
      providers.hostService.close();
      providers.managedStorage.close();
      watchers.closeAll();
    },
  };
}

// A recording's lines, played under a held clock started at its first
// request: the documents and the home are the recording's, so no owner is
// built and nothing is read or spawned for them.
function recordingArm(path: string): Arm {
  const recording = readRecording(path);
  const facts = recordingFacts(recording);
  const { startMs, steps } = playOf(recording, facts);
  const clock = heldClock(new Date(startMs));
  return {
    world: { ...machine, clock },
    facts,
    clock,
    home: recording.home,
    steps,
    arrive: heldArrival(clock),
    close: () => {},
  };
}

async function main(): Promise<void> {
  const { configPath, recording } = parseArgs(process.argv.slice(2));
  const arm = recording === null ? liveArm() : recordingArm(recording);
  try {
    using loaded = loadDemo({
      world: arm.world,
      stateDir: stateDir(machine.home),
      links: {
        to: machine.home.name,
        signer: linkSignerFromKeyFile(linkKeyFile(stateDir(machine.home))),
      },
      configPath,
      cwd,
      warn: (message) => log("warn", message),
    });
    process.stdout.write(
      `\n  DSL demo — ${configPath}\n` +
        (recording === null
          ? `  one faked status-line request, rendered by the daemon's own functions\n` +
            `  ${FRAMES} renders, one per status-line tick — watch the clock move:\n\n`
          : `  ${recording}, replayed by the daemon's own functions\n` +
            `  ${arm.steps.filter((step) => step.kind === "draw").length} renders, one per answer the session was drawn:\n\n`),
    );
    await playDemo({
      ...arm,
      loaded,
      log,
      frame: (drawn) =>
        process.stdout.write(
          ansiOf(drawn)
            .split("\n")
            .map((row) => `  ${row}\n`)
            .join(""),
        ),
    });
    process.stdout.write("\n");
  } finally {
    arm.close();
  }
}

try {
  await main();
} catch (err) {
  // A refused config or recording is the demo's expected failure: the
  // message is the whole report. Anything else is a defect and keeps its
  // stack.
  if (
    !(
      err instanceof ConfigError ||
      err instanceof DroppedPlacements ||
      err instanceof RecordingUnreadable ||
      err instanceof UsageError
    )
  )
    throw err;
  process.stderr.write(`error: ${err.message}\n`);
  process.exitCode = 1;
}
