// [LAW:behavior-not-structure] Regression guard for render-bugs-pdu.3:
// interior per-part color directives ({{ green "S" }} / {{ red "U" }}) must
// survive the full renderDsl powerline serialization as DISTINCT colored runs
// — NOT collapse to the segment-level fg. The bug was the color twin of the
// OSC-8 link-bleed (pdu.1); both share ROOT A (lossy span serialization in the
// powerline join), fixed by the bzh.9 StripCell→RichText migration. This pins
// that fix through the REAL spine (registerDslConfig + renderDsl on the bundled
// gitTaculous segment), asserting the colored output — not the call shape.
//
// [LAW:single-enforcer] Drives the production cascade: a user file overriding
// only `root` merges onto DEFAULT_DSL_CONFIG, so the gitTaculous segment and
// every git.* variable come from the bundled default exactly as the daemon
// loads them. No hand-seeded store, no synthetic single-segment template.

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";

import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";

// A git payload that fires every interior-colored branch of gitTaculous:
// staged>0 → green "S", unstaged>0 → red "U", ahead>0 → green "+1",
// behind>0 → red "-1".
const GIT_PAYLOAD = {
  hook_event_name: "Status",
  session_id: "deadbeef-1234-5678-9abc-def012345678",
  transcript_path: "/tmp/t.jsonl",
  cwd: "/tmp",
  model: { id: "claude-opus-4-8", display_name: "Opus" },
  workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
  git: {
    branch: "main",
    repoName: "repo",
    sha: "abc1234",
    staged: 2,
    unstaged: 3,
    untracked: 0,
    conflicts: 0,
    ahead: 1,
    behind: 1,
    upstream: "origin/main",
    operation: "",
    stash: 0,
    timeSinceCommit: 0,
  },
};

// One ANSI-styled run: the SGR parameters that opened it and the literal text
// it painted, before the next `ESC[...m`. Empty-text runs (bare resets, the
// powerline separator's own color) are dropped — we assert over visible glyphs.
interface Run {
  readonly sgr: string;
  readonly text: string;
}

function parseRuns(ansi: string): Run[] {
  const runs: Run[] = [];
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;]*)m([^\x1b]*)/g;
  for (const m of ansi.matchAll(re)) {
    const text = m[2] ?? "";
    if (text.length > 0) runs.push({ sgr: m[1] ?? "", text });
  }
  return runs;
}

// The foreground color an SGR run sets: either a truecolor `38;2;r;g;b` triple
// or a basic ANSI fg code (30-37 / 90-97). `null` = no explicit fg (inherits).
// This is the value pdu.3's defect collapsed; comparing it across runs is the
// behavioral invariant ("interior colors are distinct from the segment fg").
function foregroundKey(sgr: string): string | null {
  const params = sgr.split(";");
  for (let i = 0; i < params.length; i++) {
    if (params[i] === "38" && params[i + 1] === "2") {
      return `tc:${params[i + 2]};${params[i + 3]};${params[i + 4]}`;
    }
    const n = Number(params[i]);
    if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) return `basic:${n}`;
  }
  return null;
}

function render(): string {
  // User file overrides only the root; everything else is the bundled default.
  const userSource = JSON.stringify({ root: { seg: "gitTaculous" } });
  const config = parseAndValidate(
    "<interior-color>",
    userSource,
    new Set(["textual-dark"]),
    DEFAULT_DSL_CONFIG,
  );

  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  try {
    const compiled = registerDslConfig(config, registry, { cwd: "/tmp" });
    const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
    return renderDsl(config, compiled, store, registry, GIT_PAYLOAD, basePalette, {
      style: "powerline",
      colorCompatibility: "truecolor",
      width: Number.POSITIVE_INFINITY,
    });
  } finally {
    registry.dispose();
  }
}

describe("interior per-part colors survive powerline serialization (pdu.3)", () => {
  const runs = parseRuns(render());
  const runFor = (glyph: string): Run | undefined =>
    runs.find((r) => r.text.trim() === glyph);
  // The segment's default fg — the color of an un-styled run (the "(git)"
  // prefix text). pdu.3's defect was every interior run collapsing to THIS.
  const segmentRun = runs.find((r) => r.text.includes("(git)"));

  test("the segment renders a default-fg run and the colored glyphs as separate runs", () => {
    expect(segmentRun).toBeDefined();
    expect(runFor("S")).toBeDefined(); // staged
    expect(runFor("U")).toBeDefined(); // unstaged
    expect(runFor("+1")).toBeDefined(); // ahead
    expect(runFor("-1")).toBeDefined(); // behind
  });

  test("each interior-colored glyph's fg is DISTINCT from the segment fg (no collapse)", () => {
    const segFg = foregroundKey(segmentRun!.sgr);
    expect(segFg).not.toBeNull();
    for (const glyph of ["S", "U", "+1", "-1"]) {
      const fg = foregroundKey(runFor(glyph)!.sgr);
      expect(fg).not.toBeNull();
      expect(fg).not.toBe(segFg); // the defect: fg === segFg for all of them
    }
  });

  test("green (staged/ahead) and red (unstaged/behind) are distinct from each other", () => {
    const green = foregroundKey(runFor("S")!.sgr);
    const red = foregroundKey(runFor("U")!.sgr);
    expect(green).not.toBe(red);
    // The two same-color pairs agree: staged/ahead share green, unstaged/behind red.
    expect(foregroundKey(runFor("+1")!.sgr)).toBe(green);
    expect(foregroundKey(runFor("-1")!.sgr)).toBe(red);
  });

  test("every colored glyph is painted over the segment bg (composited, not bare)", () => {
    // [LAW:representation] Interior runs keep the segment background — they are
    // composited over it, not emitted as bare un-backgrounded text.
    const segBg = segmentRun!.sgr.match(/48;2;[0-9;]+?(?=;38|;39|$|m)/);
    expect(segBg).not.toBeNull();
    for (const glyph of ["S", "U", "+1", "-1"]) {
      expect(runFor(glyph)!.sgr).toContain("48;2;");
    }
  });
});
