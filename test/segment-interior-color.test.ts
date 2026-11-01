// [LAW:behavior-not-structure] Regression net for render-bugs-pdu.3, a STALE
// bug: per-part colors were reported collapsing to the segment fg, but the
// interior spans already survive (bzh.9's StripCell→RichText migration fixed
// ROOT A — the same lossy-serialization root as the pdu.1 link bleed). This
// pins that so the collapse can't silently return. Merging onto the real
// DEFAULT_DSL_CONFIG (not a hand-rolled template) is deliberate: a synthetic
// segment could pass while the SHIPPED gitaculous regresses.


import { drawPayload } from "./helpers/draw-payload";
import type { Frame, Run } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { registerDslConfig } from "../src/dsl/render";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { instantOf } from "../src/utils/instant";

// Fires every interior-colored branch: staged→green "S", unstaged→red "U",
// ahead→green "+1", behind→red "-1".
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
    committedAt: 0,
  },
};

// A colour a run sets itself, as a truecolor hex or a palette `color(n)`: the
// terminal's own `default` is none. `Run.fg` is the value pdu.3's defect
// collapsed to a single segment fg, so comparing it across runs is the
// behavioral invariant. Compositing means every interior glyph keeps the
// SEGMENT's bg, so `Run.bg` must match across the segment and its colored glyphs.
const SET = /^(#|color\()/;

function render(): Frame {
  const userSource = JSON.stringify({ root: { seg: "gitaculous" } });
  const config = parseAndValidate(
    "<interior-color>",
    userSource,
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );

  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  try {
    const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
    return drawPayload(config, compiled, store, registry, GIT_PAYLOAD, instantOf(new Date()), {
      endcaps: "powerline",
      colorCompatibility: "truecolor", wrap: true, padding: 0,
      width: Number.POSITIVE_INFINITY,
    }).frame;
  } finally {
    registry.dispose();
  }
}

describe("interior per-part colors survive powerline serialization (pdu.3)", () => {
  const runs = render().rows.flatMap((row) => row.runs);
  const runFor = (glyph: string): Run | undefined =>
    runs.find((r) => r.text.trim() === glyph);
  // The structural text the segment's own fg paints: the branch glyph, which
  // leads the collapsed form a session starts in.
  const segmentRun = runs.find((r) => r.text.includes("⎇"));

  test("the segment renders a default-fg run and the colored glyphs as separate runs", () => {
    expect(segmentRun).toBeDefined();
    expect(runFor("S")).toBeDefined();
    expect(runFor("U")).toBeDefined();
    expect(runFor("+1")).toBeDefined();
    expect(runFor("-1")).toBeDefined();
  });

  test("each interior-colored glyph's fg is DISTINCT from the segment fg (no collapse)", () => {
    const segFg = segmentRun!.fg;
    expect(segFg).toMatch(SET);
    for (const glyph of ["S", "U", "+1", "-1"]) {
      const { fg } = runFor(glyph)!;
      expect(fg).toMatch(SET);
      expect(fg).not.toBe(segFg);
    }
  });

  test("green (staged/ahead) and red (unstaged/behind) are distinct from each other", () => {
    const green = runFor("S")!.fg;
    const red = runFor("U")!.fg;
    expect(green).not.toBe(red);
    expect(runFor("+1")!.fg).toBe(green);
    expect(runFor("-1")!.fg).toBe(red);
  });

  test("every colored glyph is painted over the segment bg (composited, not bare)", () => {
    const segBg = segmentRun!.bg;
    expect(segBg).toMatch(SET);
    for (const glyph of ["S", "U", "+1", "-1"]) {
      expect(runFor(glyph)!.bg).toBe(segBg);
    }
  });
});
