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
import { placementDraftKey } from "../src/config/edit-chrome";

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
  session: Readonly<Record<string, string>> = {},
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
  for (const [key, value] of Object.entries(session)) {
    sessionState.set(SESSION, key, value);
  }
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
    ["repo", "expanded", " repo"],
    ["upstream", "expanded", " [origin/feature +2/-1]"],
    ["sha", "expanded", " abc1234"],
    ["stash", "expanded", " (1 stashed)"],
    ["age", "expanded", " ◷ 5m"],
  ] as const)("%s off drops %s's %j", (setting, detail, fact) => {
    const { full, lean } = renderPair({ [setting]: false }, detail as Detail);
    expect(full).toContain(fact);
    expect(lean).toBe(full.replace(fact, ""));
  });

  // Configure mode's pick is a session string: "false" must read as false,
  // or the fact would stay after the user unticks it on the bar.
  test("a configure-mode draft turns a fact off in its copy only", () => {
    const { full, lean } = renderPair({}, "expanded", {
      [placementDraftKey("default", "lean", "sha")]: "false",
    });
    expect(full).toContain(" abc1234");
    expect(lean).toBe(full.replace(" abc1234", ""));
  });

  // Adding one setting to the bundled segment keeps the six it inherits, which
  // the bundled pieces go on reading.
  test("a file's settings merge by name over the bundled ones", () => {
    const config = parseAndValidate(
      "<user>",
      JSON.stringify({
        segments: {
          gitaculous: {
            settings: { compact: { label: "c", domain: "bool", default: false } },
          },
        },
      }),
      new Set(listResolvablePaletteNames()),
      DEFAULT_DSL_CONFIG,
    );
    expect(Object.keys(config.segments.gitaculous!.settings ?? {})).toEqual(
      expect.arrayContaining(["compact", "sha", "flags", "upstream"]),
    );
  });

  // A piece reads its fact's setting, so a template of the user's own that
  // calls it without declaring that setting is refused at load — at the
  // CALLER, the one place the fix goes, naming the helper it reached through.
  const load = (decl: object) =>
    parseAndValidate(
      "<user>",
      JSON.stringify({ ...decl, root: { h: ["mySha"] } }),
      new Set(listResolvablePaletteNames()),
      DEFAULT_DSL_CONFIG,
    );
  test("a segment calling a piece must declare its setting", () => {
    const withSettings = (settings: object) =>
      load({
        segments: { mySha: { template: '{{ template "gitSha" . }}', settings } },
      });
    expect(() => withSettings({})).toThrow(
      /segments\.mySha\.template[^\n]*"\.settings\.sha" through helper "gitSha", but segment "mySha" has no setting "sha"/,
    );
    expect(() =>
      withSettings({ sha: { label: "sha", domain: "bool", default: true } }),
    ).not.toThrow();
  });

  test("a variable calling a piece is told only a segment has settings", () => {
    expect(() =>
      load({
        variables: {
          shaText: { kind: "template", template: '{{ template "gitSha" . }}' },
        },
        segments: { mySha: { template: "{{ .shaText }}" } },
      }),
    ).toThrow(
      /through helper "gitSha", but only a segment's own templates have settings/,
    );
  });

  test("a segment-local variable is told the same, whatever the segment declares", () => {
    expect(() =>
      load({
        segments: {
          mySha: {
            template: "{{ .mySha.text }}",
            settings: { sha: { label: "sha", domain: "bool", default: true } },
            vars: {
              text: { kind: "template", template: '{{ template "gitSha" . }}' },
            },
          },
        },
      }),
    ).toThrow(
      /through helper "gitSha", but only a segment's own templates have settings/,
    );
  });
});
