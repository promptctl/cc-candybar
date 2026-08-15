// [LAW:behavior-not-structure] Regression net for render-bugs-pdu.3, a STALE
// bug: per-part colors were reported collapsing to the segment fg, but the
// interior spans already survive (bzh.9's StripCell→RichText migration fixed
// ROOT A — the same lossy-serialization root as the pdu.1 link bleed). This
// pins that so the collapse can't silently return. Merging onto the real
// DEFAULT_DSL_CONFIG (not a hand-rolled template) is deliberate: a synthetic
// segment could pass while the SHIPPED gitaculous regresses.

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";

import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { listResolvablePaletteNames } from "../src/themes/policy";

// Fires the shared GIT_FG vocabulary's interior glyphs: staged→green "S",
// unstaged→yellow "U", ahead→green "+1", behind→yellow "-1" (staged/ahead share
// green, unstaged/behind share yellow). untracked (magenta "?") stays 0 here so
// this fixture keeps exercising the same four runs it always has; the untracked-
// vs-unstaged split is pinned in default-dsl-config.test.ts.
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

// The foreground a run sets — the value pdu.3's defect collapsed to a single
// segment fg; comparing it across runs is the behavioral invariant. Both the
// truecolor `38;2;r;g;b` form and a basic ANSI code (30-37/90-97) count.
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

// The background a run sets (truecolor `48;2;r;g;b` or basic 40-47/100-107) —
// compositing means every interior glyph keeps the SEGMENT's bg, so this must
// match across the segment and its colored glyphs.
function backgroundKey(sgr: string): string | null {
  const params = sgr.split(";");
  for (let i = 0; i < params.length; i++) {
    if (params[i] === "48" && params[i + 1] === "2") {
      return `tc:${params[i + 2]};${params[i + 3]};${params[i + 4]}`;
    }
    const n = Number(params[i]);
    if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) return `basic:${n}`;
  }
  return null;
}

function render(): string {
  const userSource = JSON.stringify({ root: { seg: "gitaculous" } });
  const config = parseAndValidate(
    "<interior-color>",
    userSource,
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );

  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  try {
    const compiled = registerDslConfig(config, registry, { cwd: "/tmp" });
    const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
    return renderDsl(config, compiled, store, registry, GIT_PAYLOAD, basePalette, {
      style: "powerline",
      colorCompatibility: "truecolor", wrap: true, padding: 0, charset: "unicode" as const,
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
  const segmentRun = runs.find((r) => r.text.includes("(git)"));

  test("the segment renders a default-fg run and the colored glyphs as separate runs", () => {
    expect(segmentRun).toBeDefined();
    expect(runFor("S")).toBeDefined();
    expect(runFor("U")).toBeDefined();
    expect(runFor("+1")).toBeDefined();
    expect(runFor("-1")).toBeDefined();
  });

  test("each interior-colored glyph's fg is DISTINCT from the segment fg (no collapse)", () => {
    const segFg = foregroundKey(segmentRun!.sgr);
    expect(segFg).not.toBeNull();
    for (const glyph of ["S", "U", "+1", "-1"]) {
      const fg = foregroundKey(runFor(glyph)!.sgr);
      expect(fg).not.toBeNull();
      expect(fg).not.toBe(segFg);
    }
  });

  test("green (staged/ahead) and yellow (unstaged/behind) are distinct from each other", () => {
    const green = foregroundKey(runFor("S")!.sgr);
    const yellow = foregroundKey(runFor("U")!.sgr);
    expect(green).not.toBe(yellow);
    expect(foregroundKey(runFor("+1")!.sgr)).toBe(green);
    expect(foregroundKey(runFor("-1")!.sgr)).toBe(yellow);
  });

  test("every colored glyph is painted over the segment bg (composited, not bare)", () => {
    const segBg = backgroundKey(segmentRun!.sgr);
    expect(segBg).not.toBeNull();
    for (const glyph of ["S", "U", "+1", "-1"]) {
      expect(backgroundKey(runFor(glyph)!.sgr)).toBe(segBg);
    }
  });
});
