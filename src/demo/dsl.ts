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
// buildRenderState, resolveEffectiveGlobals, buildRenderPayload, renderDsl —
// over the providers the daemon builds (createPayloadProviders). There is no
// demo-only payload: a field the daemon's payload gains is in the demo's.
// The config is the one file named here, loaded or refused; the daemon's
// search for a config and its diagnostic strip are not part of the demo.
//
// [LAW:dataflow-not-control-flow] The body is straight-line: load → frames →
// dispose. The config file and the hook event are data; swapping either
// changes the output without changing this code. Rendering N frames over time
// is not branching — it lets the config's own timed sources (shell, time)
// populate, exactly as the daemon re-renders on each status-line tick.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { detectClientHints } from "../client-hints.js";
import { ConfigError } from "../config/loader/diagnostics.js";
import { buildRenderState } from "../daemon/cache/render.js";
import { WatcherRegistry } from "../daemon/cache/watchers.js";
import type { DaemonLogger } from "../daemon/log.js";
import { createPayloadProviders } from "../daemon/payload-providers.js";
import { parseClientHints } from "../daemon/protocol.js";
import {
  buildRenderPayload,
  renderOptionsOf,
  renderSelectionOf,
  resolveEffectiveGlobals,
} from "../daemon/render-payload.js";
import { SessionState } from "../daemon/session-state.js";
import { settingCounts } from "../daemon/setting-drafts.js";
import { EMPTY_HISTORY_DEPTH } from "../daemon/settings-history.js";
import { renderDsl } from "../dsl/render.js";
import { DEFAULT_TERMINAL_WIDTH } from "../render/strip.js";
import type { ClaudeHookData } from "../utils/claude.js";
import { debug } from "../utils/logger.js";
import { applyClaudeCodeReserve } from "../utils/terminal-width.js";

const FRAMES = 4;
const FRAME_INTERVAL_MS = 450;

const here = dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
const configPath = resolve(process.argv[2] ?? join(here, "statusline.json5"));
const sessionId = "demo0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b";

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
const width = applyClaudeCodeReserve(hints.termCols ?? DEFAULT_TERMINAL_WIDTH);

// [LAW:no-silent-failure] What the daemon writes to daemon.log, the demo says
// on stderr when it is a problem; the daemon's routine lines stay behind
// CC_CANDYBAR_DEBUG. The demo never writes the daemon's own log file.
const log: DaemonLogger = (level, message) =>
  level === "info"
    ? debug(message)
    : void process.stderr.write(`${level}: ${message}\n`);
const warn = (message: string): void => log("warn", message);

const watchers = new WatcherRegistry({ logger: log });
const providers = createPayloadProviders({ watchers, logger: log });
// A session that has never clicked: every pick is absent, so each setting
// resolves to the config's own value, every picker is closed, and there is
// nothing to undo or go back to.
const sessionState = new SessionState();
const sessionPick = (key: string): string | null =>
  sessionState.get(sessionId, key);

// The demo renders the file it was given or nothing. The advisories a file
// earns are reported whether or not it goes on to load, as the daemon's strip
// and `cc-candybar check` report them.
function loadState(): ReturnType<typeof buildRenderState> {
  const advisories: Array<string | null> = [];
  try {
    return buildRenderState(cwd, configPath, advisories, {
      gitService: providers.gitProvider,
      sessionState,
    });
  } catch (err) {
    if (err instanceof ConfigError) advisories.push(...err.warnings);
    throw err;
  } finally {
    advisories.filter((a) => a !== null).forEach(warn);
  }
}

async function renderFrames(): Promise<void> {
  const state = loadState();
  try {
    const effective = resolveEffectiveGlobals(
      state.config,
      sessionPick,
      (preset: string) => state.authoredRoots.has(preset),
    );

    process.stdout.write(
      `\n  DSL demo — ${configPath}\n` +
        `  one faked status-line request, rendered by the daemon's own functions\n` +
        `  ${FRAMES} renders, one per status-line tick — watch the clock move:\n\n`,
    );

    for (let frame = 0; frame < FRAMES; frame++) {
      const payload = await buildRenderPayload(
        hookData,
        {
          ...providers,
          history: () => EMPTY_HISTORY_DEPTH,
          navigation: () => 0,
        },
        cwd,
        state.neededInputPaths(effective.preset),
        effective,
        hints,
        {
          ...settingCounts(state.config, state.fileHeldSettings, sessionPick),
          configPath,
        },
      );
      const line = renderDsl(
        state.config,
        state.compiled,
        state.store,
        state.registry,
        payload,
        renderOptionsOf(effective, width),
        { onRenderWarning: warn },
        renderSelectionOf(effective),
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
    state.registry.dispose();
  }
}

try {
  await renderFrames();
} catch (err) {
  // A refused config is the demo's one expected failure: the loader's message
  // is the whole report. Anything else is a defect and keeps its stack.
  if (!(err instanceof ConfigError)) throw err;
  process.stderr.write(`error: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  // The providers own their timers and watchers; all of them are released so
  // the process ends when the frames do.
  providers.gitProvider.close();
  providers.usageStore.close();
  watchers.closeAll();
}
