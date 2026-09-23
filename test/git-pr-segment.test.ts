// [LAW:verifiable-goals] The shipped gitPr segment, driven through the REAL
// spine (registerDslConfig + renderDsl) and the REAL loader — the same path the
// daemon renders through. Asserts the three render-distinguishable states the
// forge outcome produces, and that the OSC-8 link region opens AND closes
// cleanly (the link-bleed guard: a region that opens but never closes bleeds
// the hyperlink onto the rest of the terminal).


import { RAW_DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { EDIT_NS } from "../src/config/loader/reserved-namespace";
import { EDIT_TOGGLE_ACTION } from "../src/config/loader/edit-mode";
import { linkCloseCount, linkUrls } from "./helpers/ansi";

// Reparse the AUTHORED literal (pre-synthesis) — see
// test/default-dsl-config.test.ts for why this must be the raw form, not the
// already-synthesized DEFAULT_DSL_CONFIG.
const SERIALIZED = JSON.stringify(RAW_DEFAULT_DSL_CONFIG, null, 2);

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 1, charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};


function renderGitPr(git: Record<string, unknown>): string {
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
  const dropEditNs = <V>(rec: Readonly<Record<string, V>>) =>
    Object.fromEntries(
      Object.entries(rec).filter(
        // `edit.toggle` stays: the settings menu's `✎ edit` fires it (a `do`),
        // and it is a plain cycle that compiles with nothing else of edit mode.
        ([name]) => !name.startsWith(EDIT_NS) || name === EDIT_TOGGLE_ACTION,
      ),
    );
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
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  try {
    const compiled = registerDslConfig(parsed, registry, { cwd: "/tmp" });
    const payload = {
      hook_event_name: "Status",
      session_id: "deadbeef-1234-5678-9abc-def012345678",
      cwd: "/tmp",
      model: { id: "claude-opus-4-8", display_name: "Opus" },
      workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
      git,
    };
    return renderDsl(parsed, compiled, store, registry, payload, OPTS);
  } finally {
    registry.dispose();
  }
}

describe("gitPr segment render", () => {
  test("open PR → one OSC-8 link to the PR url, opened AND closed", () => {
    const url = "https://github.com/promptctl/cc-candybar/pull/76";
    const out = renderGitPr({
      branch: "brandon-git-76s",
      prNumber: 76,
      prState: "OPEN",
      prUrl: url,
    });

    // Exactly one clickable region, carrying the PR url verbatim (the terminal
    // opens https directly — no cc-candybar:// verb round-trip).
    expect(linkUrls(out)).toEqual([url]);
    // The number is shown; the region closes cleanly (no link bleed).
    expect(out).toContain("#76");
    // Exactly one open and one close — the region is balanced.
    expect(linkCloseCount(out)).toBe(1);
  });

  test("lookup failed → distinct ⚠ marker, NO link", () => {
    const out = renderGitPr({
      branch: "brandon-git-76s",
      prError: "gh pr view: non-zero, exit 1, HTTP 401",
    });

    expect(linkUrls(out)).toEqual([]);
    expect(out).toContain("⚠");
    expect(out).toContain("PR");
  });

  test("no PR → segment absent (when-gated, empty line)", () => {
    const out = renderGitPr({ branch: "brandon-git-76s" });
    expect(linkUrls(out)).toEqual([]);
    expect(out).not.toContain("PR");
    expect(out).not.toContain("#");
  });
});
