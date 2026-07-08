// [LAW:verifiable-goals] Every shipped example config under examples/ must
// survive the full production pipeline: parse → merge-on-default → validate →
// register → render. A template parse error in an inline override, a dangling
// segment/action reference, or a palette name the registry can't resolve would
// otherwise rot silently until a user copies the file onto their bar.
//
// [LAW:behavior-not-structure] The assertion is the contract a user relies on —
// "this documented config loads and renders" — not any internal shape. The test
// discovers files by globbing the directory, so a new example is covered the
// moment it lands (no per-file edit).
//
// examples/legacy-parity.json5 is the migration-completeness capstone
// (brandon-config-aoi): this test is what keeps that proof honest over time.

import fs from "node:fs";
import path from "node:path";

import {
  parseDslConfig,
  mergeWithDefault,
  validateConfig,
} from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import {
  listResolvablePaletteNames,
  effectiveThemeName,
} from "../src/themes/policy";
import { resolverForThemeName } from "../src/themes/palette-resolvers";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import {
  DEFAULT_CHARSET,
  DEFAULT_COLOR_COMPATIBILITY,
  DEFAULT_PADDING,
  DEFAULT_WRAP,
} from "../src/render/strip";

const examplesDir = path.join(__dirname, "..", "examples");
const ALLOWED = new Set(listResolvablePaletteNames());

// One faked Claude Code hook event, shaped like the daemon's augmented payload
// (see src/daemon/render-payload.ts) — the `input` vars read out of it by their
// dotted `path`. [LAW:verifiable-goals] It is deliberately RICH (dirty git with
// every worktree count, an upstream, a stash, a recent commit; home set; live
// session/today/context/metrics/rate-limit data) so the gated segments actually
// RENDER their content instead of gating off. A minimal payload would let a
// field-name typo in the git/directory/metrics/budget branches slip through —
// those branches only run when their data is present.
const home = "/home/tester";
const nowSec = Math.floor(Date.now() / 1000);
const payload = {
  hook_event_name: "Status",
  session_id: "test0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b",
  version: "1.15.0",
  home,
  cwd: `${home}/code/cc-candybar/src`,
  transcript_path: `${home}/.claude/projects/x/test.jsonl`,
  model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
  workspace: {
    current_dir: `${home}/code/cc-candybar/src`,
    project_dir: `${home}/code/cc-candybar`,
  },
  git: {
    repoName: "cc-candybar",
    branch: "main",
    sha: "abc1234",
    ahead: 2,
    behind: 1,
    staged: 3,
    unstaged: 2,
    untracked: 1,
    conflicts: 0,
    upstream: "origin/main",
    stash: 1,
    status: "dirty",
    operation: "rebase",
    timeSinceCommit: 780,
  },
  session: { cost: 0.39, tokens: 241400 },
  today: { cost: 12.5, tokens: 3_400_000 },
  context: { totalTokens: 48487, contextLeft: 24 },
  metrics: {
    lastResponseTime: 8.2,
    responseTime: 4.2,
    sessionDuration: 930,
    messageCount: 8,
    linesAdded: 512,
    linesRemoved: 88,
  },
  block: { nativeUtilization: 63, resetsAt: nowSec + 2 * 3600 },
  weekly: { percentage: 21, resetsAt: nowSec + 5 * 86400 },
  cache: { expiresAt: nowSec + 15 * 60 },
  tmux: { session: "work" },
  // The daemon-resolved effective theme name (effectiveThemeName folds the
  // session pick over globals.palette). The showcase/legacy-parity triggers read
  // `.theme.effective` to show the active theme single-sourced from the palette.
  theme: { effective: "catppuccin-mocha" },
};

const exampleFiles = fs
  .readdirSync(examplesDir)
  .filter((f) => f.endsWith(".json5"))
  .sort();

// The full production pipeline for one example file: parse → merge on the REAL
// bundled default (examples declare only deltas and reference bundled segments)
// → validate → register → render against the rich payload. Returns the rendered
// line. register+render is the step that surfaces template parse errors in
// inline overrides AND (with a rich payload) runtime field-access errors —
// go-template-js throws MissingFieldError on a mistyped `.git.xxx` path.
function renderExample(file: string): string {
  const filePath = path.join(examplesDir, file);
  const source = fs.readFileSync(filePath, "utf-8");
  const raw = parseDslConfig(filePath, source, ALLOWED);
  const merged = mergeWithDefault(raw, DEFAULT_DSL_CONFIG);
  const config = validateConfig(merged, filePath, source, ALLOWED);

  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  try {
    const compiled = registerDslConfig(config, registry, {
      cwd: process.cwd(),
    });
    const basePalette = resolverForThemeName(
      effectiveThemeName(null, config.globals.palette),
    );
    // [LAW:one-source-of-truth] Resolve the render options from the merged
    // config's globals with the DEFAULT_* floor as fallback — the exact
    // resolution the daemon (src/daemon/server.ts) and src/demo/dsl.ts apply.
    // Hardcoding DEFAULT_* would render legacy-parity's globals.autoWrap:false
    // (and padding/charset) as their defaults, not as the config declares them.
    return renderDsl(config, compiled, store, registry, payload, basePalette, {
      style: "powerline",
      width: 200,
      colorCompatibility:
        config.globals.colorCompatibility ?? DEFAULT_COLOR_COMPATIBILITY,
      wrap: config.globals.autoWrap ?? DEFAULT_WRAP,
      padding: config.globals.padding ?? DEFAULT_PADDING,
      charset: config.globals.charset ?? DEFAULT_CHARSET,
    });
  } finally {
    registry.dispose();
  }
}

// ANSI SGR + OSC-8 hyperlink stripped, leaving the visible glyph text. The
// OSC-8 introducer is terminated by EITHER ST (ESC \) or BEL (\x07) per spec —
// match both so the helper strips a valid sequence regardless of terminator.
function visible(line: string): string {
  return line
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x1b\\|\x07)/g, "");
}

describe("shipped example configs (examples/*.json5)", () => {
  // Guard against the glob silently matching nothing (a moved directory would
  // make every it.each below vanish and the suite pass vacuously).
  test("at least the known examples are present", () => {
    expect(exampleFiles).toEqual(
      expect.arrayContaining([
        "legacy-parity.json5",
        "showcase.json5",
        "demo-actions.json5",
        "demo-variables.json5",
      ]),
    );
  });

  test.each(exampleFiles)(
    "%s loads, validates, and renders on the production pipeline",
    (file) => {
      const line = renderExample(file);
      expect(typeof line).toBe("string");
      expect(line.length).toBeGreaterThan(0);
    },
  );

  // [LAW:behavior-not-structure] The capstone parity config: assert the rich
  // template branches actually render their content, not merely that render
  // doesn't throw. This is the guard for the git-with-◷ override, both directory
  // forms (fish-abbreviated + unabbreviated), and the metrics segment — the
  // exact branches a minimal payload would gate off.
  test("legacy-parity renders the full legacy information set", () => {
    const out = visible(renderExample("legacy-parity.json5"));
    // git (line 3) with the ◷ time-since-commit override → "13m" from 780s.
    expect(out).toContain("⎇ main");
    expect(out).toContain("◷ 13m");
    // fish-abbreviated directory (line 1) AND the unabbreviated directoryFull
    // (line 4) both derive from home — distinct forms prove both branches ran.
    expect(out).toContain("~/c/c/src"); // fish: leaf full, ancestors to leading char
    expect(out).toContain("~/code/cc-candybar/src"); // directoryFull: unabbreviated
    // metrics segment (line 2) — all six flags render from the cost/transcript.
    expect(out).toContain("◆ 8");
    expect(out).toContain("+ 512");
    // [LAW:one-source-of-truth] The theme trigger reads the daemon-resolved
    // `theme.effective` var — the label is single-sourced from globals.palette
    // (no pinned `variables.theme.default` restatement), so it renders the
    // effective theme name the payload carries.
    expect(out).toContain("🎨 catppuccin-mocha");
    // session/today cost + block/weekly quota + version.
    expect(out).toContain("§ $0.39");
    expect(out).toContain("v1.15.0");
    expect(out).toContain("63%"); // block utilization
  });
});
