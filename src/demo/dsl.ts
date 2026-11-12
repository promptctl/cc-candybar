// Minimal end-to-end demo of the segment DSL render spine.
//
//   pnpm demo                       # renders src/demo/statusline.json5
//   pnpm demo path/to/other.json5   # renders any DSL config
//
// pnpm runs scripts from the repo root, so a relative path resolves there,
// not in the directory you typed the command in.
//
// [LAW:single-enforcer] One faked hook event, with the hints a statusline
// client reports from this terminal (detectClientHints), goes through the
// functions the daemon runs for a real one — parseClientHints, loadChain,
// a collector and openView over the daemon's session source, settleWorld,
// drawDsl — over the providers the daemon builds (createPayloadProviders).
// There is no demo-only payload: a field the daemon's payload gains is in the
// demo's.
// The config is the one file named here, loaded or refused; the daemon's
// search for a config and its diagnostics viewer are not part of the demo.
//
// [LAW:dataflow-not-control-flow] The body is straight-line: load → frames →
// dispose. The config file and the hook event are data; swapping either
// changes the output without changing this code. Rendering N frames over time
// is not branching — it lets the config's own timed sources (shell, time)
// populate, exactly as the daemon re-renders on each status-line tick.

import { linkKeyFile, linkSignerFromKeyFile } from "../daemon/link-key.js";
import { daemonGates } from "../daemon/update-keys.js";
import { locations, stateDir } from "../daemon/paths.js";
import { repoGateAt } from "../daemon/repo-configs.js";
import { repoGateLines } from "../config/loader/repo-gate.js";
import { UNFOLLOWED_FEEDS } from "../config/lanes.js";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { sleep } from "../time.js";

import { detectClientHints } from "../client-hints.js";
import {
  ConfigError,
  DroppedPlacements,
} from "../config/loader/diagnostics.js";
import { homeLayer, refuseDrops } from "../config/dsl-loader.js";
import {
  loadChain,
  openView,
  subscriptionsOf,
  UNOWNED_STORAGE,
  type DslRenderState,
} from "../daemon/cache/render.js";
import { WatcherRegistry } from "../daemon/cache/watchers.js";
import { NO_FILE_EVENTS } from "../daemon/cache/file-events.js";
import type { DaemonLogger } from "../utils/logger.js";
import { createPayloadProviders } from "../daemon/payload-providers.js";
import { processWorld } from "../host.js";
import { RefreshLedger } from "../utils/refresh-ledger.js";
import { parseClientHints } from "../daemon/protocol.js";
import {
  renderOptionsOf,
  renderWidth,
  settleWorld,
  todayOf,
} from "../daemon/render-payload.js";
import { Collector } from "../daemon/collector.js";
import { WorldStates } from "../renderer/world-states.js";
import { sessionIdOf } from "../daemon/session-id.js";
import { sessionSource } from "../daemon/session-source.js";
import { SessionState } from "../daemon/session-state.js";
import { newUpdateFact } from "../daemon/update-fact.js";
import { EMPTY_HISTORY_DEPTH } from "../daemon/settings-history.js";
import { drawDsl } from "../dsl/render.js";
import { SessionEffects } from "../render/effect.js";
import { ansiOf } from "../render/frame.js";
import type { RenderedLine } from "../dsl/node-registry.js";
import type { CheckedHookData } from "../renderer/request-context.js";
import { debug, setDebug } from "../utils/logger.js";
import { instantOf } from "../utils/instant.js";
import { SourceRuns } from "../daemon/source-runs.js";
import type { Subscriptions } from "../renderer/interface.js";

const FRAMES = 4;
const FRAME_INTERVAL_MS = 450;

const here = dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
// [LAW:effects-at-boundaries] This script is its own process main: it reads the
// machine once, as src/index.ts does, and the debug channel follows it.
const world = processWorld();
// [LAW:single-enforcer] The demo's own owner of its sources' runs, which its
// collector holds, closed when the demo ends.
const runs = new SourceRuns({ launcher: world.launcher, clock: world.clock });
const { host } = world;
setDebug(Boolean(host.env.CC_CANDYBAR_DEBUG));
const configPath = resolve(process.argv[2] ?? join(here, "statusline.json5"));
const sessionId = sessionIdOf("demo0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b");

// One Claude Code hook event, faked. A session that has never run has no
// transcript, so the path names no file — a missing transcript is an empty
// session, not a failure.
const hookData: CheckedHookData = {
  hook_event_name: "Status",
  session_id: sessionId,
  transcript_path: join(host.tmp, `cc-candybar-demo-${sessionId}.jsonl`),
  cwd,
  model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
  workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
};
// The demo's frames go to stdout, so stdout is the stream on the terminal.
const hints = parseClientHints(detectClientHints(host, cwd, process.stdout));
const width = renderWidth(hints);

// [LAW:no-silent-failure] What the daemon writes to daemon.log, the demo says
// on stderr when it is a problem; the daemon's routine lines stay behind
// CC_CANDYBAR_DEBUG. The demo never writes the daemon's own log file.
const log: DaemonLogger = (level, message) =>
  level === "info"
    ? debug(message)
    : void process.stderr.write(`${level}: ${message}\n`);
const warn = (message: string): void => log("warn", message);

const watchers = new WatcherRegistry({ clock: world.clock, logger: log });
const providers = createPayloadProviders({
  launcher: world.launcher,
  host,
  watchers,
  // The demo holds no folder and watches nothing.
  fileEvents: NO_FILE_EVENTS,
  clock: world.clock,
  logger: log,
  ledger: new RefreshLedger(log),
  sourceRuns: runs,
});
// A session that has never clicked: every pick is absent, so each setting
// resolves to the config's own value, every picker is closed, and there is
// nothing to undo or go back to.
const sessionState = new SessionState();

// The demo renders the file it was given or nothing. The advisories a file
// earns are reported whether or not it goes on to load, as the daemon's strip
// and `cc-candybar check` report them.
function loadState(): DslRenderState {
  const locs = locations(host);
  const repos = repoGateAt(stateDir(host), cwd);
  // The file it was given is named explicitly: no repository supplies it.
  const chain = {
    layers: [homeLayer(configPath)],
    home: configPath,
    repo: repos.plugins,
    locs,
  };
  // [LAW:single-enforcer] The daemon's own load and settle: the advisories
  // come out of the one place every load composes them.
  const loaded = loadChain(
    {
      repos,
      advisories: repoGateLines(repos),
      started: world.clock.monotonic(),
    },
    cwd,
    chain,
    {
      clock: world.clock,
      locations: locs,
      env: host.env,
      sessionState,
      storage: UNOWNED_STORAGE,
      signer: linkSignerFromKeyFile(linkKeyFile(stateDir(host))),
      gates: daemonGates(),
      stateDir: stateDir(host),
    },
  );
  if (loaded.warning !== null) warn(loaded.warning);
  if (loaded.state === null) throw loaded.cause;
  return loaded.state;
}

async function renderFrames(): Promise<void> {
  const state = loadState();
  // [LAW:no-silent-failure] The daemon draws past a placement of an undeclared
  // segment; the demo, like `check`, refuses it with the loader's message.
  try {
    refuseDrops(state.dropped);
  } catch (e) {
    state.registry.dispose();
    runs.close();
    throw e;
  }
  // The demo runs no update watch: its world state carries an update nothing
  // has sampled.
  const updateFact = newUpdateFact();
  // [LAW:single-enforcer] The session's world state, read by the host's own
  // collector over the demo's providers and handed straight to the store its
  // view reads, as the daemon's renderer takes it.
  const worldStates = new WorldStates();
  // What the view needs read, handed back after every world state as the
  // host hands back every turn's output: a run named once a fact landed is
  // subscribed by the turn that landed it. Nothing until the view opens.
  let subscriptions = (): Subscriptions => ({ sources: new Map() });
  const collector = new Collector({
    owners: providers,
    update: () => updateFact.get(),
    clock: world.clock,
    // The demo's one session is drawn for as long as it runs.
    watched: () => true,
    deliver: async (event) => {
      if (event.kind === "world-state") worldStates.take(event.worldState);
      collector.subscribed(subscriptions());
      return { kind: "answered" };
    },
    log,
  });
  const request = { hookData, cwd, hints };
  // What the collector holds goes with the demo, whatever stops it.
  try {
    worldStates.take(collector.requested(request));
    // The session's view of the state, as the daemon opens one per session,
    // drawn by the one request the demo's frames draw by.
    const view = openView(state, cwd, request, {
      source: sessionSource({
        sessionState,
        worldStates,
        home: providers.home,
        history: () => EMPTY_HISTORY_DEPTH,
        navigation: () => 0,
      }),
      // The demo draws one frame per tick of its own: no feed to wake.
      changed: () => {},
      log,
    });
    // [LAW:one-source-of-truth] The view's subscriptions reach the collector as
    // a turn's output takes them to the daemon's.
    subscriptions = () => ({
      sources: new Map([[sessionId, subscriptionsOf(view)]]),
    });
    collector.subscribed(subscriptions());
    try {
      const effective = view.source.effective();

      process.stdout.write(
        `\n  DSL demo — ${configPath}\n` +
          `  one faked status-line request, rendered by the daemon's own functions\n` +
          `  ${FRAMES} renders, one per status-line tick — watch the clock move:\n\n`,
      );

      // The session's effect memory, held across the frames as the daemon holds
      // it across a session's requests, so a `globals.effect` moves frame to frame.
      const effects = new SessionEffects<RenderedLine>(sessionId);
      for (let frame = 0; frame < FRAMES; frame++) {
        // [LAW:effects-at-boundaries] Each frame is one status-line tick: one
        // instant, sampled here as the daemon samples it per request.
        const at = instantOf(new Date(world.clock.now()));
        await settleWorld(
          { hookData, deps: providers, cwd, hints },
          at,
          new Map(),
          () => worldStates.of(sessionId),
          () => view.registry.namedRuns().values(),
          // The demo's frames have no client to hang up.
          new AbortController().signal,
        );
        const { frame: drawn } = drawDsl(
          state.config,
          state.compiled,
          view.store,
          view.registry,
          {
            drawing: { by: "request" },
            feeds: UNFOLLOWED_FEEDS,
            today: todayOf(view.source.facts().builtins.today, at),
          },
          at,
          renderOptionsOf(effective, width),
          { onRenderWarning: ({ message }) => warn(message) },
          { ...effective, effects },
        );
        process.stdout.write(
          ansiOf(drawn)
            .split("\n")
            .map((row) => `  ${row}\n`)
            .join(""),
        );
        if (frame < FRAMES - 1) await sleep(world.clock, FRAME_INTERVAL_MS);
      }

      process.stdout.write("\n");
    } finally {
      view.dispose();
    }
  } finally {
    collector.close();
    state.registry.dispose();
    runs.close();
  }
}

try {
  await renderFrames();
} catch (err) {
  // A refused config is the demo's one expected failure: the loader's message
  // is the whole report. Anything else is a defect and keeps its stack.
  if (!(err instanceof ConfigError || err instanceof DroppedPlacements))
    throw err;
  process.stderr.write(`error: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  // The providers own their timers and watchers; all of them are released so
  // the process ends when the frames do.
  providers.gitProvider.close();
  providers.usageStore.close();
  providers.tmuxService.close();
  providers.hostService.close();
  providers.managedStorage.close();
  watchers.closeAll();
}
