// [LAW:verifiable-goals] The shipped gitPr segment, driven through the REAL
// spine (registerDslConfig + drawDsl) and the REAL loader — the same path the
// daemon renders through. Asserts the three render-distinguishable states the
// forge outcome produces, and that an open PR draws one link region.


import { drawPayload } from "./helpers/draw-payload";
import { textOf } from "../src/render/frame";
import type { Frame } from "../src/render/frame";
import { linkUrls } from "./helpers/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { RAW_DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { registerDslConfig } from "../src/dsl/render";
import { dropEditChrome } from "./helpers/narrow-to-segment";
import { instantOf } from "../src/utils/instant";

// Reparse the AUTHORED literal (pre-synthesis) — see
// test/default-dsl-config.test.ts for why this must be the raw form, not the
// already-synthesized DEFAULT_DSL_CONFIG.
const SERIALIZED = JSON.stringify(RAW_DEFAULT_DSL_CONFIG, null, 2);

const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 1,
  width: Number.POSITIVE_INFINITY,
};


function renderGitPr(git: Record<string, unknown>): Frame {
  const base = parseAndValidate("<default>", SERIALIZED);
  // Narrow the spread default to just the gitPr segment so the rendered line is
  // exactly that segment's output.
  //
  // [LAW:locality-or-seam] The settings menu references `edit.toggle`, so `synthesizeEditChrome` (inside
  // `parseAndValidate`, BEFORE this narrowing) has already baked a spliced
  // copy of the full root into `presets.default.root` and per-preset
  // `insertSegmentFrom` actions (`edit.addable.<preset>`) into `actions` —
  // both keyed off presets this test doesn't want. Reset `presets` (so the
  // narrowed `root` below isn't shadowed by that baked-in copy — see
  // `presetRoot`/`presets.ts`) and drop every synthesized `edit.*` entry
  // (gitPr's own template never references `edit.toggle`, so none of that
  // machinery is needed here).
  const dropEditNs = dropEditChrome;
  const parsed = {
    ...base,
    presets: {},
    variables: dropEditNs(base.variables),
    actions: dropEditNs(base.actions),
    segments: dropEditNs(base.segments),
    root: {
      rows: {
        main: {
          kind: "container" as const,
          direction: "horizontal" as const,
          children: [{ kind: "segment" as const, name: "gitPr" }],
        },
      },
    },
  };
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  try {
    const compiled = registerDslConfig(parsed, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
    const payload = {
      hook_event_name: "Status",
      session_id: "deadbeef-1234-5678-9abc-def012345678",
      cwd: "/tmp",
      model: { id: "claude-opus-4-8", display_name: "Opus" },
      workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
      git,
    };
    return drawPayload(parsed, compiled, store, registry, payload, instantOf(new Date()), OPTS).frame;
  } finally {
    registry.dispose();
  }
}

describe("gitPr segment render", () => {
  test("open PR → one link to the PR url", () => {
    const url = "https://github.com/promptctl/cc-candybar/pull/76";
    const out = renderGitPr({
      branch: "brandon-git-76s",
      prNumber: 76,
      prState: "open",
      prUrl: url,
    });

    // Exactly one clickable region, carrying the PR url verbatim (the terminal
    // opens https directly — no cc-candybar:// verb round-trip).
    expect(linkUrls(out)).toEqual([url]);
    // The number is shown.
    expect(textOf(out)).toContain("#76");
  });

  test("lookup failed → distinct ⚠ marker, NO link", () => {
    const out = renderGitPr({
      branch: "brandon-git-76s",
      prError: "gh pr view: non-zero, exit 1, HTTP 401",
    });

    expect(linkUrls(out)).toEqual([]);
    expect(textOf(out)).toContain("⚠");
    expect(textOf(out)).toContain("PR");
  });

  test.each(["merged", "closed"])(
    "a %s PR → segment absent: the link is for open PRs",
    (prState) => {
      const out = renderGitPr({
        branch: "brandon-git-76s",
        prNumber: 76,
        prState,
        prUrl: "https://github.com/promptctl/cc-candybar/pull/76",
      });
      expect(linkUrls(out)).toEqual([]);
      expect(textOf(out)).not.toContain("#76");
    },
  );

  test("no PR → segment absent (when-gated, empty line)", () => {
    const out = renderGitPr({ branch: "brandon-git-76s" });
    expect(linkUrls(out)).toEqual([]);
    expect(textOf(out)).not.toContain("PR");
    expect(textOf(out)).not.toContain("#");
  });
});
