// [LAW:verifiable-goals] The shipped gitPr segment, driven through the REAL
// spine (registerDslConfig + renderDsl) and the REAL loader — the same path the
// daemon renders through. Asserts the three render-distinguishable states the
// forge outcome produces, and that the OSC-8 link region opens AND closes
// cleanly (the link-bleed guard: a region that opens but never closes bleeds
// the hyperlink onto the rest of the terminal).

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";

import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { registerDslConfig, renderDsl } from "../src/dsl/render";

const SERIALIZED = JSON.stringify(DEFAULT_DSL_CONFIG, null, 2);

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true,
  width: Number.POSITIVE_INFINITY,
};

// OSC-8 open carries a non-empty URL; the close is the same introducer with an
// EMPTY url. Capturing only non-empty urls means every match is an OPEN.
// eslint-disable-next-line no-control-regex
const OSC8_OPEN = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
// eslint-disable-next-line no-control-regex
const OSC8_CLOSE = "\x1b]8;;\x1b\\";

function linkUrls(rendered: string): string[] {
  return [...rendered.matchAll(OSC8_OPEN)].map((m) => m[1]!);
}

function renderGitPr(git: Record<string, unknown>): string {
  const base = parseAndValidate("<default>", SERIALIZED);
  // Narrow the spread default to just the gitPr segment so the rendered line is
  // exactly that segment's output.
  const parsed = {
    ...base,
    root: {
      kind: "container" as const,
      direction: "vertical" as const,
      children: [
        {
          kind: "container" as const,
          direction: "horizontal" as const,
          children: [{ kind: "segment" as const, name: "gitPr" }],
        },
      ],
    },
  };
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  try {
    const compiled = registerDslConfig(parsed, registry, { cwd: "/tmp" });
    const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
    const payload = {
      hook_event_name: "Status",
      session_id: "deadbeef-1234-5678-9abc-def012345678",
      cwd: "/tmp",
      model: { id: "claude-opus-4-8", display_name: "Opus" },
      workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
      git,
    };
    return renderDsl(parsed, compiled, store, registry, payload, basePalette, OPTS);
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
    expect(out).toContain(OSC8_CLOSE);
    // Exactly one open and one close — the region is balanced.
    expect(out.split(OSC8_CLOSE).length - 1).toBe(1);
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
