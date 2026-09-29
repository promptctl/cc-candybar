// The bundled `gitaculous` segment declares which optional facts a placement
// shows (brandon-segment-settings-i4n.u36). Each case places the segment twice
// on one bar — a bare copy on every default and a copy with one setting off —
// so it pins both the setting's effect and that two copies never share a value.
import type { RichText } from "@promptctl/rich-js";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";

const SESSION = "s1";

// Every optional fact present, so each setting has something to take away.
const GIT = {
  branch: "feature",
  repoName: "repo",
  sha: "abc1234",
  staged: 1,
  unstaged: 2,
  untracked: 3,
  conflicts: 0,
  ahead: 2,
  behind: 1,
  upstream: "origin/feature",
  operation: "rebase",
  stash: 1,
  status: "dirty",
  timeSinceCommit: 300,
};

type Detail = "collapsed" | "expanded";

// The text each of two placements draws: `full` (bare) and `lean` (`settings`).
function renderPair(
  settings: Record<string, boolean>,
  detail: Detail,
): { full: string; lean: string } {
  const config = parseAndValidate(
    "<user>",
    JSON.stringify({
      root: {
        h: [
          { seg: "gitaculous", id: "full" },
          { seg: "gitaculous", id: "lean", settings },
        ],
      },
    }),
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  sessionState.set(SESSION, "git-detail", detail);
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const sink = new Map<string, readonly RichText[]>();
  try {
    const compiled = registerDslConfig(config, registry, { cwd: "/tmp" });
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: SESSION, cwd: "/tmp", git: GIT },
      {
        style: "powerline",
        colorCompatibility: "truecolor",
        wrap: true,
        padding: 0,
        charset: "unicode",
        width: Number.POSITIVE_INFINITY,
      },
      { perSegmentSink: sink },
    );
  } finally {
    registry.dispose();
  }
  const textOf = (id: string): string =>
    (sink.get(id) ?? []).map((t) => t.plain).join("").trim();
  return { full: textOf("full"), lean: textOf("lean") };
}

describe("gitaculous settings", () => {
  test("every default reproduces the segment without settings", () => {
    expect(renderPair({}, "collapsed")).toEqual({
      full: "⎇ feature +2/-1 SU? ▸",
      lean: "⎇ feature +2/-1 SU? ▸",
    });
    const { full, lean } = renderPair({}, "expanded");
    expect(full).toBe(
      "(git) repo [rebase] abc1234 SU? ⎇ feature [origin/feature +2/-1] (1 stashed) ◷ 5m ◂",
    );
    expect(lean).toBe(full);
  });

  // Turning a setting off removes exactly its fact — with its own leading
  // space — from every form that shows it, and from no other copy.
  test.each([
    ["aheadBehind", "collapsed", " +2/-1"],
    ["aheadBehind", "expanded", " +2/-1"],
    ["flags", "collapsed", " SU?"],
    ["flags", "expanded", " SU?"],
    ["operation", "expanded", " [rebase]"],
    ["sha", "expanded", " abc1234"],
    ["stash", "expanded", " (1 stashed)"],
    ["age", "expanded", " ◷ 5m"],
  ] as const)("%s off drops %s's %j", (setting, detail, fact) => {
    const { full, lean } = renderPair({ [setting]: false }, detail as Detail);
    expect(full).toContain(fact);
    expect(lean).toBe(full.replace(fact, ""));
  });

  // A piece reads its fact's setting, so a segment of the user's own that
  // calls it without declaring that setting is refused at load, at the piece.
  test("a segment calling a piece must declare its setting", () => {
    const load = (settings: object) =>
      parseAndValidate(
        "<user>",
        JSON.stringify({
          segments: {
            mySha: { template: '{{ template "gitSha" . }}', settings },
          },
          root: { h: ["mySha"] },
        }),
        new Set(listResolvablePaletteNames()),
        DEFAULT_DSL_CONFIG,
      );
    expect(() => load({})).toThrow(
      /helpers\.gitSha[^\n]*unknown variable "\.settings\.sha"/,
    );
    expect(() =>
      load({ sha: { label: "sha", domain: "bool", default: true } }),
    ).not.toThrow();
  });
});
