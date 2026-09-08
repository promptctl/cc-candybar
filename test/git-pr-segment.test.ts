// [LAW:verifiable-goals] The shipped gitPr segment driven through the REAL spine and loader — the path the daemon renders through.

import { getThemePalette } from "@promptctl/rich-js";

import { RAW_DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { EDIT_NS } from "../src/config/loader/edit-mode";

// Must be the raw pre-synthesis literal, not the already-synthesized DEFAULT_DSL_CONFIG.
const SERIALIZED = JSON.stringify(RAW_DEFAULT_DSL_CONFIG, null, 2);

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 1, charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

// The close is the same introducer with an EMPTY url, so capturing only non-empty urls means every match is an OPEN.
// eslint-disable-next-line no-control-regex
const OSC8_OPEN = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
// eslint-disable-next-line no-control-regex
const OSC8_CLOSE = "\x1b]8;;\x1b\\";

function linkUrls(rendered: string): string[] {
  return [...rendered.matchAll(OSC8_OPEN)].map((m) => m[1]!);
}

function renderGitPr(git: Record<string, unknown>): string {
  const base = parseAndValidate("<default>", SERIALIZED);
  // Reset `presets` so the narrowed `root` isn't shadowed by the copy edit-chrome synthesis already baked in, and drop its `edit.*` entries.
  const dropEditNs = <V>(rec: Readonly<Record<string, V>>) =>
    Object.fromEntries(
      Object.entries(rec).filter(([name]) => !name.startsWith(EDIT_NS)),
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
    const basePalette = getThemePalette("textual-dark"!);
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

    expect(linkUrls(out)).toEqual([url]);
    expect(out).toContain("#76");
    expect(out).toContain(OSC8_CLOSE);
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
