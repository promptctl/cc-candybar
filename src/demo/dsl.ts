// Minimal end-to-end demo of the segment DSL render spine.
//
//   pnpm demo:dsl                       # renders src/demo/statusline.json5
//   pnpm demo:dsl path/to/other.json5   # renders any DSL config
//
// [LAW:single-enforcer] This renders through registerDslConfig + renderDsl
// — the exact spine the daemon calls. There is no demo-only render path; what
// prints here is what production produces.
//
// [LAW:dataflow-not-control-flow] The body is straight-line: read config →
// register → render frames → dispose. The config file and payload are data;
// swapping either changes the output without changing this code. Rendering N
// frames over time is not branching — it lets the asynchronous sources (shell,
// time) populate the store and shows the line come alive, exactly as the daemon
// re-renders on each status-line tick.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  parseDslConfig,
  mergeWithDefault,
  validateConfig,
} from "../config/dsl-loader.js";
import { VariableStore } from "../var-system/store.js";
import { SourceRegistry } from "../var-system/sources.js";
import { SessionState } from "../daemon/session-state.js";
import { listResolvablePaletteNames } from "../themes/policy.js";
import { effectiveThemeName, resolverForThemeName } from "../themes/index.js";
import { registerDslConfig, renderDsl } from "../dsl/render.js";
import {
  DEFAULT_CHARSET,
  DEFAULT_COLOR_COMPATIBILITY,
  DEFAULT_PADDING,
  DEFAULT_TERMINAL_WIDTH,
  DEFAULT_WRAP,
} from "../render/strip.js";
import { applyClaudeCodeReserve } from "../utils/terminal-width.js";

const FRAMES = 4;
const FRAME_INTERVAL_MS = 450;

const here = dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2] ?? join(here, "statusline.json5");
const source = readFileSync(configPath, "utf-8");

// [LAW:one-source-of-truth] The palette names the loader accepts are exactly
// the names the renderer can resolve — both derive from the same registry, so
// we hand the loader the live set rather than a hand-maintained copy.
//
// Full three-stage pipeline: parse → merge → validate. The renderer accepts
// only `ValidatedConfig`, so the chain is type-enforced.
const ALLOWED = new Set(listResolvablePaletteNames());
const raw = parseDslConfig(configPath, source, ALLOWED);
const merged = mergeWithDefault(raw);
const config = validateConfig(merged, configPath, source, ALLOWED);

// One Claude Code status-line hook event, faked. The `input` vars in the
// config (cwd, model, session) read their values out of this object.
const payload = {
  hook_event_name: "Status",
  session_id: "demo0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b",
  cwd: process.cwd(),
  model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
  workspace: {
    current_dir: process.cwd(),
    project_dir: process.cwd(),
  },
};

// The demo has no SessionState; the effective theme is just the config default.
const basePalette = resolverForThemeName(
  effectiveThemeName(null, config.globals.palette),
);

// A fresh store + registry for this run. (A hot-reloading daemon would
// dispose() the old pair and build new ones — see registerDslConfig's docs.)
// registerDslConfig wires the time/shell sources' timers and watchers onto the
// registry, so dispose() must run even if registration or rendering throws —
// otherwise those handles keep the process alive. try/finally guarantees it.
const store = new VariableStore();
// [LAW:no-silent-failure] An EMPTY SessionState — `kind: "state"` variables
// (the default config's style picker, any interactive config) require one at
// registration; without it declareState fails and the segment renders an error
// cell. The demo never clicks, so an empty store is correct: every state var
// resolves to its declared default (closed pickers, "(default)" labels).
const registry = new SourceRegistry(store, "", undefined, new SessionState());
try {
  const compiled = registerDslConfig(config, registry, {
    cwd: process.cwd(),
  });

  process.stdout.write(
    `\n  DSL demo — ${configPath}\n` +
      `  rendered through registerDslConfig + renderDsl (the daemon's spine)\n` +
      `  watch the git branch segment appear and the clock tick:\n\n`,
  );

  for (let frame = 0; frame < FRAMES; frame++) {
    const line = renderDsl(
      config,
      compiled,
      store,
      registry,
      payload,
      basePalette,
      {
        style: "powerline",
        // Same resolution the daemon applies: the config global over the
        // truecolor default floor.
        colorCompatibility:
          config.globals.colorCompatibility ?? DEFAULT_COLOR_COMPATIBILITY,
        // [LAW:one-source-of-truth] Demo applies the same Claude-Code-UI
        // reserve the daemon does so demo output matches the bytes a real
        // statusline would emit at the same terminal width.
        width: applyClaudeCodeReserve(
          process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH,
        ),
        // Same resolution the daemon applies: the config global over the
        // default-on floor.
        wrap: config.globals.autoWrap ?? DEFAULT_WRAP,
        padding: config.globals.padding ?? DEFAULT_PADDING,
        charset: config.globals.charset ?? DEFAULT_CHARSET,
      },
    );
    process.stdout.write(`  ${line}\n`);
    if (frame < FRAMES - 1) await sleep(FRAME_INTERVAL_MS);
  }

  process.stdout.write("\n");
} finally {
  registry.dispose();
}
