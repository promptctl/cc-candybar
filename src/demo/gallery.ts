// Every bundled theme, one payload, one bar each.
//
//   pnpm gallery                       # the bundled default config
//   pnpm gallery path/to/config.json5  # any DSL config
//
// [LAW:single-enforcer] The config is prepared and each row rendered by
// `check`'s own pipeline (prepareConfig + renderEffective: the daemon's
// buildState, settled sources, then renderDsl), with the theme chosen the way
// a click chooses it: a session pick of `theme`, resolved by the daemon's own
// resolveEffectiveGlobals. So a row is exactly the bar picking that theme
// produces, never a gallery-only approximation of it.
//
// [LAW:one-source-of-truth] The payload is `check`'s representative fixture
// (checkPayload), rich enough that every gated segment renders its content —
// so a theme is judged on the whole bar, thresholds and all, not a sparse one.
//
// [LAW:no-silent-failure] Load warnings and render failures go to stderr, so a
// row drawn around a ⚠ cell or a collapsed `globals.palette` rule says so.

import process from "node:process";

import { resolveUserPath } from "../utils/user-path.js";
import { resolveEffectiveGlobals } from "../config/effective-globals.js";
import { prepareConfig, renderEffective } from "../check.js";
import { repoGateAt } from "../daemon/repo-configs.js";
import { repoGateLines } from "../config/loader/repo-gate.js";
import { listResolvablePaletteNames } from "../themes/policy.js";
import { instantOf } from "../utils/instant.js";

const THEMES = listResolvablePaletteNames();
const LABEL = Math.max(...THEMES.map((n) => n.length)) + 2;
const WIDTH = (process.stdout.columns ?? 200) - LABEL;

const warnings: string[] = [];
// The argv path resolved as `check` resolves its own, so `.config_path` (the
// demo switcher's sibling links) names the file absolutely.
const target = process.argv[2];
// [LAW:effects-at-boundaries] One instant for every theme, so the rows differ
// only in the theme they wear.
const at = instantOf(new Date());
const named =
  target === undefined ? undefined : resolveUserPath(process.cwd(), target);
const repos = repoGateAt(process.cwd(), named);
warnings.push(...repoGateLines(repos));
const prepared = await prepareConfig(
  named === undefined ? [] : [named],
  repos.plugins,
  process.cwd(),
  warnings,
  at,
);
try {
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
  for (const theme of THEMES) {
    const effective = resolveEffectiveGlobals(
      prepared.config,
      (key) => (key === "theme" ? theme : null),
      () => false,
    );
    const { rendered, failures, advisories } = renderEffective(
      prepared,
      effective,
      WIDTH,
      at,
    );
    for (const [label, message] of failures)
      process.stderr.write(`${theme}: ${label}: ${message}\n`);
    for (const advisory of advisories)
      process.stderr.write(`${theme}: warning: ${advisory}\n`);
    process.stdout.write(
      rendered
        .split("\n")
        .map((row, i) => (i === 0 ? theme : "").padEnd(LABEL) + row)
        .join("\n") + "\n\n",
    );
  }
} finally {
  prepared.registry.dispose();
}
