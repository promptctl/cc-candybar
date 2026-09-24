// Every bundled theme, one payload, one bar each.
//
//   pnpm gallery                       # the bundled default config
//   pnpm gallery path/to/config.json5  # any DSL config
//
// [LAW:single-enforcer] Each row is rendered through registerDslConfig +
// renderDsl — the daemon's spine — with the theme chosen the way a click
// chooses it: a session pick of `theme`, resolved by the daemon's own
// resolveEffectiveGlobals. So a row is exactly the bar picking that theme
// produces, never a gallery-only approximation of it.
//
// [LAW:one-source-of-truth] The payload is `check`'s representative fixture
// (checkPayload), rich enough that every gated segment renders its content —
// so a theme is judged on the whole bar, thresholds and all, not a sparse one.

import process from "node:process";

import { loadConfig, validateConfig } from "../config/dsl-loader.js";
import { DEFAULT_DSL_CONFIG } from "../config/default-dsl-config.js";
import { VariableStore } from "../var-system/store.js";
import { SourceRegistry } from "../var-system/sources.js";
import { SessionState } from "../daemon/session-state.js";
import { listResolvablePaletteNames } from "../themes/policy.js";
import { resolveEffectiveGlobals } from "../daemon/render-payload.js";
import { registerDslConfig, renderDsl } from "../dsl/render.js";
import { checkPayload } from "../check.js";

const ALLOWED = new Set(listResolvablePaletteNames());
const configPath = process.argv[2];
// [LAW:dataflow-not-control-flow] No config path is the bundled default AS a
// config — the same validate step either way, only the input differs.
const config = configPath
  ? (() => {
      const { config: merged, source } = loadConfig(
        configPath,
        DEFAULT_DSL_CONFIG,
        ALLOWED,
      );
      return validateConfig(merged, configPath, source, ALLOWED);
    })()
  : validateConfig(DEFAULT_DSL_CONFIG, "<bundled default>", "", ALLOWED);

const WIDTH = process.stdout.columns ?? 200;
const store = new VariableStore();
const registry = new SourceRegistry(store, "", undefined, new SessionState());
try {
  const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
  const label = Math.max(...[...ALLOWED].map((n) => n.length));
  for (const theme of listResolvablePaletteNames()) {
    const effective = resolveEffectiveGlobals(
      config,
      (key) => (key === "theme" ? theme : null),
      () => false,
    );
    const bar = renderDsl(
      config,
      compiled,
      store,
      registry,
      checkPayload(effective),
      {
        style: effective.style,
        separator: effective.separator,
        width: WIDTH - label - 2,
        colorCompatibility: effective.colorCompatibility,
        wrap: effective.autoWrap,
        padding: effective.padding,
        charset: effective.charset,
      },
      undefined,
      {
        theme: effective.theme,
        look: effective.look,
        preset: effective.preset,
      },
    );
    const indent = " ".repeat(label + 2);
    process.stdout.write(
      bar
        .split("\n")
        .map((row, i) => (i === 0 ? theme.padEnd(label + 2) : indent) + row)
        .join("\n") + "\n\n",
    );
  }
} finally {
  registry.dispose();
}
