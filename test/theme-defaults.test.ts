// [LAW:verifiable-goals] candybar-theme-colours-6fq5.ix8: each theme carries a
// default look — shade, variation, style — that it wears when nothing above
// its rung says otherwise. Pinned here:
//   1. the loader accepts `themeDefaults` and refuses a theme nothing
//      installs, a member outside each field's domain, a style the merged
//      `styles` block does not declare, a rule, and an unknown field — each
//      naming its path;
//   2. a file's entry merges over the bundled one by theme name, then field;
//   3. the rung sits between the floor and the config's globals:
//      floor < theme default < globals < session pick < staged;
//   4. the rung reaches the PIXELS: a cell's background moves when only the
//      theme's default moves, through the daemon's projection and through a
//      compile-only render alike;
//   5. a theme chosen by a rule contributes no default.
//
// [LAW:single-enforcer] Everything runs the real spine: parse → merge →
// validate, resolveEffectiveGlobals, registerDslConfig + drawDsl.

import { drawPayload } from "./helpers/draw-payload";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import type { RichText } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { mergeWithDefault } from "../src/config/dsl-loader";
import type { DslConfig, ValidatedConfig } from "../src/config/dsl-types";
import { EDIT_MODE_ARRANGE, EDIT_MODE_KEY } from "../src/config/loader/edit-mode";
import {
  parsePersistTarget,
  persistPath,
  themeDefaultKey,
} from "../src/config/loader/persist-target";
import {
  renderOptionsOf,
} from "../src/daemon/render-payload";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { registerDslConfig } from "../src/dsl/render";
import { resolvedStyle } from "../src/render/rich-theme.js";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { instantOf } from "../src/utils/instant";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";

const ALLOWED = new Set(listResolvablePaletteNames());
const load = (source: string): ValidatedConfig =>
  parseAndValidate("<user>", source, ALLOWED, DEFAULT_DSL_CONFIG);

// ─── 1. The loader ───────────────────────────────────────────────────────────

describe("themeDefaults at load", () => {
  test("an entry per installed theme parses, names only", () => {
    const config = load(`{
      themeDefaults: {
        nord: { shade: 'deepest', variation: 'duo', style: 'muted' },
        dracula: { shade: 'brighter' },
      },
    }`);
    expect(config.themeDefaults).toEqual({
      nord: { shade: "deepest", variation: "duo", style: "muted" },
      dracula: { shade: "brighter" },
    });
  });

  test.each([
    [
      "a theme nothing installs",
      `{ themeDefaults: { 'no-such-theme': { shade: 'deepest' } } }`,
      'themeDefaults.no-such-theme: "no-such-theme" is not an installed theme',
    ],
    [
      "a shade outside the dial",
      `{ themeDefaults: { nord: { shade: 'darkest' } } }`,
      "themeDefaults.nord.shade must be one of: muted, deepest, deeper, middle, brighter, brightest, wide, widest, pair, pair-wide; got \"darkest\"",
    ],
    [
      "a variation outside the table",
      `{ themeDefaults: { nord: { variation: 'rainbow' } } }`,
      'themeDefaults.nord.variation must be one of: accent, duo, mono, alt, door-primary, door-secondary, door-alternate, start-primary, start-secondary, start-alternate, end-primary, end-secondary, end-alternate, ends-primary, ends-secondary, ends-alternate; got "rainbow"',
    ],
    [
      "a style the merged styles block does not declare",
      `{ themeDefaults: { nord: { style: 'glossy' } } }`,
      'themeDefaults.nord.style "glossy" does not match any declared style',
    ],
    [
      "a rule in place of a style name",
      `{ themeDefaults: { nord: { style: '{{ if true }}dim{{ end }}' } } }`,
      "themeDefaults.nord.style: a rule is not allowed here — a theme's default is the look that theme wears by name, so it names a value",
    ],
    [
      "an endcaps shape in place of a style, pointing at where endcaps live",
      `{ themeDefaults: { nord: { style: 'powerline' } } }`,
      'themeDefaults.nord.style: "powerline" is an endcaps shape, not a style — endcaps were renamed from "style" to "endcaps"; write globals.endcaps: "powerline"',
    ],
    [
      "a reset of a theme default for a theme nothing installs",
      `{ actions: { r: { reset: 'themeDefaults.no-such-theme.shade' } } }`,
      'actions.r: "themeDefaults.no-such-theme.shade" names theme "no-such-theme" which is not installed',
    ],
    [
      "a reset of a theme default field that is not part of a look",
      `{ actions: { r: { reset: 'themeDefaults.nord.padding' } } }`,
      'a "themeDefaults.<theme>.<shade|variation|style>" target',
    ],
    [
      "a field that is not part of a look",
      `{ themeDefaults: { nord: { padding: 2 } } }`,
      'Unknown theme default key "padding"',
    ],
    [
      "a block that is not an object",
      `{ themeDefaults: 'nord' }`,
      "themeDefaults must be an object mapping theme names to { shade, variation, style }",
    ],
  ])("refuses %s", (_what, source, message) => {
    expect(() => load(source)).toThrow(message);
  });

  test("a reset may name one theme's default field", () => {
    const config = load(`{ actions: { r: { reset: 'themeDefaults.nord.shade' } } }`);
    expect(config.actions.r).toEqual({ reset: "themeDefaults.nord.shade" });
  });

  test("a style the FILE declares is a name a theme default may use", () => {
    const config = load(`{
      styles: { glossy: { chromaScale: 1.3 } },
      themeDefaults: { nord: { style: 'glossy' } },
    }`);
    expect(config.themeDefaults.nord).toEqual({ style: "glossy" });
  });
});

// ─── 2. The merge ────────────────────────────────────────────────────────────

describe("themeDefaults merge", () => {
  test("by theme name, then field by field over the bundled entry", () => {
    const base: DslConfig = {
      ...DEFAULT_DSL_CONFIG,
      themeDefaults: {
        nord: { shade: "deepest", variation: "duo", style: "muted" },
        dracula: { shade: "brighter" },
      },
    };
    const merged = mergeWithDefault(
      { themeDefaults: { nord: { shade: "brightest" }, monokai: { variation: "mono" } } },
      base,
    );
    expect(merged.themeDefaults).toEqual({
      nord: { shade: "brightest", variation: "duo", style: "muted" },
      dracula: { shade: "brighter" },
      monokai: { variation: "mono" },
    });
  });
});

// ─── 3. Precedence ───────────────────────────────────────────────────────────

describe("the theme-default rung", () => {
  const look = (
    config: DslConfig,
    picks: Record<string, string> = {},
  ): readonly [string, string, string] => {
    const e = resolveEffectiveGlobals(
      config,
      (key) => picks[key] ?? null,
      () => false,
    );
    return [
      e.shade,
      e.variation,
      e.style.kind === "decided" ? e.style.name : "(rule)",
    ];
  };

  test("floor < theme default < globals < session pick < staged", () => {
    const floor = load(`{ globals: { palette: 'nord' } }`);
    expect(look(floor)).toEqual(["middle", "accent", "none"]);

    const themed = load(`{
      globals: { palette: 'nord' },
      themeDefaults: { nord: { shade: 'deepest', variation: 'duo', style: 'muted' } },
    }`);
    expect(look(themed)).toEqual(["deepest", "duo", "muted"]);

    // The user's own globals win over the theme's default, field by field.
    const globals = load(`{
      globals: { palette: 'nord', shade: 'brighter' },
      themeDefaults: { nord: { shade: 'deepest', variation: 'duo', style: 'muted' } },
    }`);
    expect(look(globals)).toEqual(["brighter", "duo", "muted"]);

    // A session pick wins over both.
    expect(look(globals, { shade: "brightest", style: "dim" })).toEqual([
      "brightest",
      "duo",
      "dim",
    ]);

    // Edit mode's staged fragment wins over everything.
    const staged = load(`{
      globals: { palette: 'nord', shade: 'brighter' },
      editGlobals: { shade: 'muted' },
      themeDefaults: { nord: { shade: 'deepest', variation: 'duo', style: 'muted' } },
    }`);
    expect(
      look(staged, { shade: "brightest", [EDIT_MODE_KEY]: EDIT_MODE_ARRANGE }),
    ).toEqual(["muted", "duo", "muted"]);
  });

  test("the entry read is the ACTIVE theme's: a theme pick changes the look", () => {
    const config = load(`{
      globals: { palette: 'nord' },
      themeDefaults: {
        nord: { shade: 'deepest' },
        dracula: { shade: 'brightest', variation: 'mono' },
      },
    }`);
    expect(look(config)).toEqual(["deepest", "accent", "none"]);
    expect(look(config, { theme: "dracula" })).toEqual([
      "brightest",
      "mono",
      "none",
    ]);
    // A theme with no entry wears the floors.
    expect(look(config, { theme: "monokai" })).toEqual([
      "middle",
      "accent",
      "none",
    ]);
  });

  test("a preset's globals outrank the theme's default, as the file's do", () => {
    const config = load(`{
      globals: { palette: 'nord' },
      presets: { mine: { globals: { variation: 'alt' } } },
      themeDefaults: { nord: { shade: 'deepest', variation: 'duo' } },
    }`);
    expect(look(config, { preset: "mine" })).toEqual(["deepest", "alt", "none"]);
  });

  test("a theme chosen by a rule contributes no default", () => {
    const config = load(`{
      globals: { palette: '{{ if true }}nord{{ end }}' },
      themeDefaults: { nord: { shade: 'deepest' } },
    }`);
    expect(look(config)).toEqual(["middle", "accent", "none"]);
  });
});

// ─── 4. The pixels ───────────────────────────────────────────────────────────

const OPTS_WIDTH = Number.POSITIVE_INFINITY;
const SID = "theme-defaults";

// One segment with no `bg:` — it wears the decoration its address and the
// look deal it — rendered through the daemon's own projection and, separately,
// as a compile-only caller that resolves nothing.
function cellBg(source: string): { daemon: string; compileOnly: string } {
  const config = load(source);
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
  const sink = new Map<string, readonly RichText[]>();
  const bg = (): string => {
    const cells = sink.get("cell");
    if (cells === undefined) throw new Error(`segment "cell" did not render`);
    return resolvedStyle(cells[0]!.style).bgcolor!.value!.hex;
  };
  try {
    const effective = resolveEffectiveGlobals(config, () => null, () => false);
    const at = instantOf(new Date());
    drawPayload(
      config,
      compiled,
      store,
      registry,
      { session_id: SID },
      at,
      renderOptionsOf(effective, OPTS_WIDTH),
      { perSegmentSink: sink },
      effective,
    ).frame;
    const daemon = bg();
    drawPayload(
      config,
      compiled,
      store,
      registry,
      { session_id: SID },
      at,
      renderOptionsOf(effective, OPTS_WIDTH),
      { perSegmentSink: sink },
    ).frame;
    return { daemon, compileOnly: bg() };
  } finally {
    registry.dispose();
  }
}

const bar = (themeDefaults: string): string => `{
  globals: { palette: 'nord' },
  segments: { cell: { template: 'here' } },
  root: { h: ['cell'] },
  themeDefaults: ${themeDefaults},
}`;

describe("a theme's default reaches the bar", () => {
  test("only the theme's default moves, and the cell's background moves with it", () => {
    const plain = cellBg(bar("{}"));
    const deep = cellBg(bar("{ nord: { shade: 'deepest' } }"));
    expect(deep.daemon).not.toBe(plain.daemon);
    // The compile-only render draws what the daemon draws.
    expect(plain.compileOnly).toBe(plain.daemon);
    expect(deep.compileOnly).toBe(deep.daemon);
  });

  test("an entry for a theme the bar is not wearing changes nothing", () => {
    expect(cellBg(bar("{ dracula: { shade: 'deepest' } }"))).toEqual(
      cellBg(bar("{}")),
    );
  });

  test("the user's own globals.shade outranks the theme's default on the bar", () => {
    const pinned = (td: string): string => `{
      globals: { palette: 'nord', shade: 'brighter' },
      segments: { cell: { template: 'here' } },
      root: { h: ['cell'] },
      themeDefaults: ${td},
    }`;
    expect(cellBg(pinned("{ nord: { shade: 'deepest' } }"))).toEqual(
      cellBg(pinned("{}")),
    );
  });
});

// ─── 5. The key a save or reset writes ───────────────────────────────────────

describe("a theme-default key", () => {
  // A theme name is whatever rich-js installs; nothing here forbids a dot.
  test("round-trips any theme name, a dotted one included", () => {
    for (const theme of ["nord", "tokyo-night", "solarized.dark"]) {
      const target = parsePersistTarget(themeDefaultKey(theme, "shade"));
      expect(target).toEqual({ scope: "theme-default", theme, field: "shade" });
      if (target?.scope !== "theme-default") throw new Error(`${theme}: no theme-default target`);
      expect(persistPath(target)).toEqual(["themeDefaults", theme, "shade"]);
    }
  });

  test("names a theme and one of the look fields", () => {
    expect(parsePersistTarget("themeDefaults.nord.endcaps")).toBeNull();
    expect(parsePersistTarget("themeDefaults.nord")).toBeNull();
    expect(parsePersistTarget("themeDefaults..shade")).toBeNull();
  });
});
