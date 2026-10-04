// [LAW:verifiable-goals] brandon-tmux-tk7: a `slash` control shows exactly
// where its click has a pane to type into. Each of the client's three tmux
// answers — a pane, "not in tmux", and nothing (a client too old to say) — is
// driven through the daemon's own payload assembly (buildRenderPayload) and the
// real spine (registerDslConfig + renderDsl), over the bundled default with
// every bundled slash control on the bar: the `commands` tray, `autocompact`,
// and the settings menu's own tray, its door open.

import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { PRESET_FLOOR } from "../src/config/presets";
import { EMPTY_HISTORY_DEPTH } from "../src/daemon/settings-history";
import {
  buildNeededPrefixes,
  buildRenderPayload,
  type EffectiveGlobals,
  type RenderPayloadDeps,
} from "../src/daemon/render-payload";
import type { ClientHints } from "../src/daemon/protocol";
import { resolveThemeSelection } from "../src/themes/palette-resolvers";
import { VERB_SLASH } from "../src/click/wire";
import { ABSENT, ok } from "../src/utils/outcome";
import { effectsOf } from "./helpers/click";
import { linkUrls, stripAnsi } from "./helpers/ansi";
import { FLOOR_STYLE } from "./helpers/floor-style";
import { NO_CONFIG_FILE } from "./helpers/config-file-facts";

const SID = "slash-gate";
const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};
const EFFECTIVE: EffectiveGlobals = {
  theme: resolveThemeSelection(undefined, null, "textual-dark"),
  style: FLOOR_STYLE,
  preset: "default",
  presetCustomized: false,
  endcaps: "powerline",
  variation: "accent",
  charset: "unicode",
  colorCompatibility: "truecolor",
  autoWrap: true,
  padding: 0,
  updateNotice: true,
  separator: undefined,
};
const HOOK_DATA = {
  hook_event_name: "Status",
  session_id: SID,
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/tmp",
  model: { id: "claude-opus-4-7", display_name: "Opus" },
  workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
};

// What the bar draws for a session whose client reported `hints`: the visible
// text, and the line each slash control would type, in drawing order.
async function bar(
  hints: ClientHints,
): Promise<{ text: string; lines: string[]; sessionLookups: number }> {
  const config = parseAndValidate(
    "<user>",
    `{ globals: {}, root: { h: ['commands', 'autocompact'] } }`,
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );
  let sessionLookups = 0;
  const deps = {
    gitProvider: { getGitInfo: async () => ABSENT },
    usageStore: {
      getUsageInfo: async () => ABSENT,
      getTodayInfo: async () => ABSENT,
    },
    contextProvider: { getContextInfo: async () => ABSENT },
    metricsProvider: { getMetricsInfo: async () => ABSENT },
    activityProvider: { getActivityInfo: async () => ABSENT },
    mementoProvider: { getCeiling: async () => ABSENT },
    tmuxService: {
      getSessionName: async () => {
        sessionLookups++;
        return ok("work");
      },
    },
    autoCompact: () => ok(400_000),
    log: () => {},
    history: () => EMPTY_HISTORY_DEPTH,
    navigation: () => 0,
  } as unknown as RenderPayloadDeps;
  const payload = await buildRenderPayload(
    HOOK_DATA,
    deps,
    undefined,
    buildNeededPrefixes(config, PRESET_FLOOR),
    EFFECTIVE,
    hints,
    NO_CONFIG_FILE,
  );

  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp" });
  const render = (): string =>
    renderDsl(config, compiled, store, registry, payload, OPTS);
  // Open the door by the write its own link carries, so the menu's session
  // tab — and its tray — is on the bar too.
  const door = linkUrls(render())
    .flatMap((u) => effectsOf(u))
    .find((e) => e.args[1] === "candybar.menu")!;
  sessionState.set(SID, door.args[1]!, door.args[2]!);
  const raw = render();
  registry.dispose();
  return {
    text: stripAnsi(raw),
    lines: linkUrls(raw)
      .flatMap((u) => effectsOf(u))
      .filter((e) => e.verb === VERB_SLASH)
      .map((e) => e.args[1]!),
    sessionLookups,
  };
}

const PANE = { socket: "/tmp/tmux.sock", pane: "%7", truecolor: null };

describe("slash controls and the session's tmux pane", () => {
  test("in a pane: both trays and autocompact's controls are drawn", async () => {
    const { text, lines } = await bar({ tmux: PANE });
    expect(text).toContain("🎨 look");
    expect(lines).toEqual([
      // the menu's session tab, above the bar: its tray, then its autocompact
      "/compact",
      "/model",
      "/autocompact 300000",
      "/autocompact 500000",
      "/autocompact auto",
      // the bar's own tray, then autocompact
      "/compact",
      "/model",
      "/autocompact 300000",
      "/autocompact 500000",
      "/autocompact auto",
    ]);
  });

  test.each<[string, ClientHints]>([
    ["not in tmux", { tmux: null }],
    ["a client too old to say", {}],
  ])("%s: no slash control anywhere, and the window still reads", async (_name, hints) => {
    const { text, lines } = await bar(hints);
    expect(text).toContain("🎨 look");
    expect(lines).toEqual([]);
    expect(text).not.toContain("/compact");
    expect(text).not.toContain("/clear");
    expect(text).toContain("⇲ 400.0K");
    expect(text).not.toMatch(/⇲ 400\.0K\s*[−+↺]/);
  });

  test("gating on the pane asks tmux nothing", async () => {
    expect((await bar({ tmux: PANE })).sessionLookups).toBe(0);
  });
});
