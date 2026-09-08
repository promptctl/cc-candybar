// `pnpm demo:dsl [path/to/config.json5]`.
// [LAW:single-enforcer] The exact spine the daemon calls; no demo-only path.
// [LAW:dataflow-not-control-flow] N frames let async sources populate the store.

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
import { DEFAULT_DSL_CONFIG } from "../config/default-dsl-config.js";
import { VariableStore } from "../var-system/store.js";
import { SourceRegistry } from "../var-system/sources.js";
import { SessionState } from "../daemon/session-state.js";
import { listResolvablePaletteNames } from "../themes/policy.js";
import { lookKeyByName, paletteForThemeName } from "../themes/index.js";
import { resolveEffectiveGlobals } from "../daemon/render-payload.js";
import { registerDslConfig, renderDsl } from "../dsl/render.js";
import { DEFAULT_TERMINAL_WIDTH } from "../render/strip.js";
import { applyClaudeCodeReserve } from "../utils/terminal-width.js";

const FRAMES = 4;
const FRAME_INTERVAL_MS = 450;

const here = dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2] ?? join(here, "statusline.json5");
const source = readFileSync(configPath, "utf-8");

// [LAW:one-source-of-truth] The live palette-name set, not a copy.
const ALLOWED = new Set(listResolvablePaletteNames());
const raw = parseDslConfig(configPath, source, ALLOWED);
const merged = mergeWithDefault(raw, DEFAULT_DSL_CONFIG);
const config = validateConfig(merged, configPath, source, ALLOWED);

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

// [LAW:one-source-of-truth] THE daemon's resolver, not a mirror of it.
const effective = resolveEffectiveGlobals(
  config,
  () => null,
  () => false,
);
const basePalette = paletteForThemeName(effective.theme);
const lookKey = lookKeyByName(config.looks, effective.look);

// The registry owns timers and watchers, so dispose() must run even on a throw.
const store = new VariableStore();
// [LAW:no-silent-failure] `kind: "state"` needs a SessionState; empty is correct.
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
        style: effective.style,
        separator: effective.separator,
        colorCompatibility: effective.colorCompatibility,
        // [LAW:one-source-of-truth] The same reserve the daemon applies.
        width: applyClaudeCodeReserve(
          process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH,
        ),
        wrap: effective.autoWrap,
        padding: effective.padding,
        charset: effective.charset,
      },
      undefined,
      { look: lookKey, preset: effective.preset },
    );
    process.stdout.write(`  ${line}\n`);
    if (frame < FRAMES - 1) await sleep(FRAME_INTERVAL_MS);
  }

  process.stdout.write("\n");
} finally {
  registry.dispose();
}
