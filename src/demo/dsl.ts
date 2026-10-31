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
// functions the daemon runs for a real one — parseClientHints,
// loadChain, openView over the daemon's session source, settlePayload,
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

import { linkSignerFromKeyFile } from "../daemon/link-key.js";
import { repoGateAt } from "../daemon/repo-configs.js";
import { repoGateLines } from "../config/loader/repo-gate.js";
import { UNFOLLOWED_FEEDS } from "../config/lanes.js";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { detectClientHints } from "../client-hints.js";
import {
  ConfigError,
  DroppedPlacements,
} from "../config/loader/diagnostics.js";
import { homeLayer, refuseDrops } from "../config/dsl-loader.js";
import {
  loadChain,
  openView,
  UNOWNED_STORAGE,
  type DslRenderState,
} from "../daemon/cache/render.js";
import { WatcherRegistry } from "../daemon/cache/watchers.js";
import { FileEventDelivery } from "../daemon/cache/file-events.js";
import type { DaemonLogger } from "../utils/logger.js";
import { createPayloadProviders } from "../daemon/payload-providers.js";
import { processLauncher } from "../proc/launch.js";
import { RefreshLedger } from "../utils/refresh-ledger.js";
import { parseClientHints } from "../daemon/protocol.js";
import {
  declareLanes,
  renderOptionsOf,
  renderWidth,
  settlePayload,
  todayOf,
} from "../daemon/render-payload.js";
import { sessionIdOf } from "../daemon/session-id.js";
import { sessionSource } from "../daemon/session-source.js";
import { SessionState } from "../daemon/session-state.js";
import { EMPTY_HISTORY_DEPTH } from "../daemon/settings-history.js";
import { drawDsl } from "../dsl/render.js";
import { SessionEffects } from "../render/effect.js";
import type { RenderedLine } from "../dsl/node-registry.js";
import type { ClaudeHookData } from "../utils/claude.js";
import { debug } from "../utils/logger.js";
import { instantOf } from "../utils/instant.js";

const FRAMES = 4;
const FRAME_INTERVAL_MS = 450;

const here = dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
const configPath = resolve(process.argv[2] ?? join(here, "statusline.json5"));
const sessionId = sessionIdOf("demo0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b");

// One Claude Code hook event, faked. A session that has never run has no
// transcript, so the path names no file — a missing transcript is an empty
// session, not a failure.
const hookData: ClaudeHookData = {
  hook_event_name: "Status",
  session_id: sessionId,
  transcript_path: join(tmpdir(), `cc-candybar-demo-${sessionId}.jsonl`),
  cwd,
  model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
  workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
};
// The demo's frames go to stdout, so stdout is the stream on the terminal.
const hints = parseClientHints(
  detectClientHints(process.env, cwd, process.stdout),
);
const width = renderWidth(hints);

// [LAW:no-silent-failure] What the daemon writes to daemon.log, the demo says
// on stderr when it is a problem; the daemon's routine lines stay behind
// CC_CANDYBAR_DEBUG. The demo never writes the daemon's own log file.
const log: DaemonLogger = (level, message) =>
  level === "info"
    ? debug(message)
    : void process.stderr.write(`${level}: ${message}\n`);
const warn = (message: string): void => log("warn", message);

const watchers = new WatcherRegistry({ logger: log });
const providers = createPayloadProviders({
  launcher: processLauncher,
  watchers,
  // Never started: the demo holds no folder and watches nothing.
  fileEvents: new FileEventDelivery({ watchers, logger: log }),
  logger: log,
  ledger: new RefreshLedger(log),
});
// A session that has never clicked: every pick is absent, so each setting
// resolves to the config's own value, every picker is closed, and there is
// nothing to undo or go back to.
const sessionState = new SessionState();

// The demo renders the file it was given or nothing. The advisories a file
// earns are reported whether or not it goes on to load, as the daemon's strip
// and `cc-candybar check` report them.
function loadState(): DslRenderState {
  const repos = repoGateAt(cwd);
  // The file it was given is named explicitly: no repository supplies it.
  const chain = {
    layers: [homeLayer(configPath)],
    home: configPath,
    repo: repos.plugins,
  };
  // [LAW:single-enforcer] The daemon's own load and settle: the advisories
  // come out of the one place every load composes them.
  const loaded = loadChain(
    {
      repos,
      advisories: repoGateLines(repos),
      started: performance.now(),
    },
    cwd,
    chain,
    {
      launcher: processLauncher,
      sessionState,
      storage: UNOWNED_STORAGE,
      signer: linkSignerFromKeyFile(),
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
    throw e;
  }
  // The session's view of the state, as the daemon opens one per session,
  // declared with the one request the demo's frames draw by.
  const view = openView(
    state,
    cwd,
    { sessionId, hookData, cwd, hints },
    {
      sessionState,
      declare: (holds, facts, closure, sources) =>
        declareLanes(providers, holds, facts, closure, sources),
      source: sessionSource({
        providers,
        sessionState,
        history: () => EMPTY_HISTORY_DEPTH,
        navigation: () => 0,
      }),
      // The demo draws one frame per tick of its own: no feed to wake.
      changed: () => {},
      log,
    },
  );
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
      const at = instantOf(new Date());
      await settlePayload(
        {
          hookData,
          deps: { ...providers, lanes: view.lanes },
          cwd,
          neededInputPaths: state.neededInputPaths(effective.preset),
          hints,
        },
        at,
        new Map(),
      );
      const { text: line } = drawDsl(
        state.config,
        state.compiled,
        view.store,
        view.registry,
        {
          drawing: { by: "request" },
          feeds: UNFOLLOWED_FEEDS,
          today: todayOf(providers, view.lanes().today, hookData, at),
        },
        at,
        renderOptionsOf(effective, width),
        { onRenderWarning: ({ message }) => warn(message) },
        { ...effective, effects },
      );
      process.stdout.write(
        line
          .split("\n")
          .map((row) => `  ${row}\n`)
          .join(""),
      );
      if (frame < FRAMES - 1) await sleep(FRAME_INTERVAL_MS);
    }

    process.stdout.write("\n");
  } finally {
    view.dispose();
    state.registry.dispose();
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
