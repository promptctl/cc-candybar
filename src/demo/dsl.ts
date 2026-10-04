// Minimal end-to-end demo of the segment DSL render spine.
//
//   pnpm demo                       # renders src/demo/statusline.json5
//   pnpm demo path/to/other.json5   # renders any DSL config
//
// pnpm runs scripts from the repo root, so a relative path resolves there,
// not in the directory you typed the command in.
//
// [LAW:single-enforcer] One faked status-line request goes through the
// functions the daemon runs for a real one — parseClientHints,
// buildRenderState, resolveEffectiveGlobals, buildRenderPayload, renderDsl —
// over the providers the daemon builds (createPayloadProviders). There is no
// demo-only render path and no demo-only payload: a field the daemon's
// payload gains is in the demo's.
//
// [LAW:dataflow-not-control-flow] The body is straight-line: load → frames →
// dispose. The config file and the request are data; swapping either changes
// the output without changing this code. Rendering N frames over time is not
// branching — it lets the asynchronous sources (shell, time, git) populate
// and shows the line come alive, exactly as the daemon re-renders on each
// status-line tick.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { buildRenderState } from "../daemon/cache/render.js";
import { WatcherRegistry } from "../daemon/cache/watchers.js";
import type { DaemonLogger } from "../daemon/log.js";
import { createPayloadProviders } from "../daemon/payload-providers.js";
import {
  PROTOCOL_VERSION,
  parseClientHints,
  type RenderRequest,
} from "../daemon/protocol.js";
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
import { detectClaudeConfigDir } from "../claude-settings.js";
import { detectMementoEnv } from "../memento-hint.js";
import { detectTmuxHint } from "../tmux-hint.js";
import { DEFAULT_TERMINAL_WIDTH } from "../render/strip.js";
import { debug } from "../utils/logger.js";
import { applyClaudeCodeReserve } from "../utils/terminal-width.js";

const FRAMES = 4;
const FRAME_INTERVAL_MS = 450;

const here = dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
const configPath = resolve(process.argv[2] ?? join(here, "statusline.json5"));
const sessionId = "demo0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b";

// The request a statusline client would send for this terminal: one Claude
// Code hook event, faked, and the hints the client reads from its own
// environment. A session that has never run has no transcript, so the path
// names no file — a missing transcript is an empty session, not a failure.
const request: RenderRequest = {
  v: PROTOCOL_VERSION,
  kind: "render",
  hookData: {
    hook_event_name: "Status",
    session_id: sessionId,
    transcript_path: join(tmpdir(), `cc-candybar-demo-${sessionId}.jsonl`),
    cwd,
    model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
    workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
  },
  args: ["cc-candybar", "--config", configPath],
  cwd,
  termCols: process.stdout.columns,
  termRows: process.stdout.rows,
  ssh: false,
  tmux: detectTmuxHint(process.env),
  claudeConfigDir: detectClaudeConfigDir(process.env, cwd),
  mementoEnv: detectMementoEnv(process.env, cwd),
};
const { hookData } = request;
const hints = parseClientHints(request);
const width = applyClaudeCodeReserve(hints.termCols ?? DEFAULT_TERMINAL_WIDTH);

// [LAW:no-silent-failure] What the daemon writes to daemon.log, the demo says
// on stderr when it is a problem; the daemon's routine lines stay behind
// CC_CANDYBAR_DEBUG. The demo never writes the daemon's own log file.
const log: DaemonLogger = (level, message) =>
  level === "info"
    ? debug(message)
    : void process.stderr.write(`${level}: ${message}\n`);

const watchers = new WatcherRegistry({ logger: log });
const providers = createPayloadProviders({ watchers, logger: log });
// A session that has never clicked: every pick is absent, so each setting
// resolves to the config's own value, every picker is closed, and there is
// nothing to undo or go back to.
const sessionState = new SessionState();
const sessionPick = (key: string): string | null =>
  sessionState.get(sessionId, key);

const warnings: Array<string | null> = [];
// A config that does not load throws here, with the loader's message: the demo
// renders the file it was given or nothing.
const state = buildRenderState(cwd, configPath, warnings, {
  gitService: providers.gitProvider,
  sessionState,
});
try {
  for (const warning of warnings) {
    if (warning !== null) process.stderr.write(`warning: ${warning}\n`);
  }
  const effective = resolveEffectiveGlobals(
    state.config,
    sessionPick,
    (preset: string) => state.authoredRoots.has(preset),
  );

  process.stdout.write(
    `\n  DSL demo — ${configPath}\n` +
      `  one faked status-line request, rendered by the daemon's own functions\n` +
      `  watch the git branch segment appear and the clock tick:\n\n`,
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
      {
        onRenderWarning: (message: string) =>
          process.stderr.write(`warning: ${message}\n`),
      },
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
  // The registry owns the config's timers and watchers, the providers their
  // own; all of them are released so the process ends when the frames do.
  state.registry.dispose();
  providers.gitProvider.close();
  providers.usageStore.close();
  watchers.closeAll();
}
