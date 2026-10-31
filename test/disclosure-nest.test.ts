// brandon-menus-sjhy.9p6: when a parent menu closes, every sub-menu inside it
// closes with it. One test per case on the ticket's case list (comment
// cmt-b97df8ef), each clicking the links the bar renders through the verbs the
// daemon runs, then reopening the parent to find the child closed.

import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import type { RichText } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import {
  VERBS,
  SESSION_RENDER_ORIGIN_KEY,
  encodeRenderOrigin,
  type VerbContext,
} from "../src/daemon/verbs";
import { linkUrls, stripAnsi } from "./helpers/ansi";
import { instantOf } from "../src/utils/instant";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import { EDIT_MODE_KEY, EDIT_MODE_ARRANGE } from "../src/config/loader/edit-mode";
import { disclosureNest } from "../src/config/disclosure-nest";
import { closingView } from "../src/daemon/closing-view";

const ALLOWED = new Set(listResolvablePaletteNames());
const SID = "s1";
const TAB = "candybar.tab";
const PICKERS = "menus.candybar_pickers";
const GEAR_PICKERS = "menus.candybar_gearPickers";
const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  width: Number.POSITIVE_INFINITY,
};
const PAYLOAD = {
  session_id: SID,
  tmux: { pane: "%0" },
  project_dir: "/tmp/proj",
  workspace: { current_dir: "/tmp/proj" },
  model: { display_name: "Opus" },
};

function buildRuntime(src: string) {
  const config = parseAndValidate("<user>", src, ALLOWED, DEFAULT_DSL_CONFIG);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", sessionState);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp/proj" });
  const sink = new Map<string, readonly RichText[]>();
  const render = (): string => {
    sink.clear();
    return renderDsl(config, compiled, store, registry, PAYLOAD, instantOf(new Date()), OPTS, {
      perSegmentSink: sink,
    });
  };
  sessionState.set(
    SID,
    SESSION_RENDER_ORIGIN_KEY,
    encodeRenderOrigin({ projectDir: "/tmp/proj", cwd: "/tmp/proj", target: { source: "search" } }),
  );
  const logged: string[] = [];
  const ctx: VerbContext = {
    ...testVerbContext(sessionState),
    configFor: () => config,
    log: (_level, line) => logged.push(line),
  };
  // One click is one verb call, as the daemon runs it.
  const click = (url: string): void => {
    const { verb, value } = parseHandlerUrl(url);
    VERBS.get(verb)!(value, ctx);
  };
  // Click the affordance whose URL writes `value` to a key `key` names
  // (exactly, or as a prefix ending in `*`), wherever it landed.
  const clickWriting = (key: string, value: string): void => {
    const matches = (k: string): boolean =>
      key.endsWith("*") ? k.startsWith(key.slice(0, -1)) : k === key;
    const url = linkUrls(render()).find((u) =>
      effectsOf(u).some((e) => matches(e.args[1] ?? "") && e.args[2] === value),
    );
    if (!url) throw new Error(`no affordance writing ${key}=${value} rendered`);
    click(url);
  };
  // What the session reads: a cleared key holds its state variable's default.
  const held = (key: string): string =>
    sessionState.get(SID, key) ?? disclosureNest(config).defaultOf(key);
  return { config, sessionState, render, clickWriting, held, logged, ctx };
}

const BUNDLED = `{ root: { h: ['directory', 'model'] } }`;
const openDoor = (rt: ReturnType<typeof buildRuntime>): void =>
  rt.clickWriting(SETTINGS_ANCHOR, "open");

describe("case 1: a tab's lists and submenus close with the tab", () => {
  test.each([
    ["its trigger", (rt: ReturnType<typeof buildRuntime>) => rt.clickWriting(TAB, DISCLOSURE_CLOSED)],
    ["opening another tab", (rt: ReturnType<typeof buildRuntime>) => rt.clickWriting(TAB, "config")],
  ])("the effect list, closing 🎨 look by %s", (_how, close) => {
    const rt = buildRuntime(BUNDLED);
    openDoor(rt);
    rt.clickWriting(TAB, "look");
    rt.clickWriting(PICKERS, "candybar.apply.effect");
    close(rt);
    rt.clickWriting(TAB, "look");
    expect(rt.held(PICKERS)).toBe(DISCLOSURE_CLOSED);
  });

  test("🧪 toggles, closing ⚙ config by opening ⚡ session", () => {
    const rt = buildRuntime(BUNDLED);
    openDoor(rt);
    rt.clickWriting(TAB, "config");
    rt.clickWriting(PICKERS, "toggles");
    rt.clickWriting(TAB, "session");
    expect(rt.held(PICKERS)).toBe(DISCLOSURE_CLOSED);
  });

  test("a list on the door's own line stays open when a tab closes: one key, held outside the tab", () => {
    const rt = buildRuntime(BUNDLED);
    openDoor(rt);
    rt.clickWriting(TAB, "look");
    rt.clickWriting(PICKERS, "candybar.apply.theme");
    rt.clickWriting(TAB, "config");
    expect(rt.held(PICKERS)).toBe("candybar.apply.theme");
  });
});

describe("case 2: the gear's lists close with the gear", () => {
  test.each([
    ["its trigger", DISCLOSURE_CLOSED],
    ["opening 🎨 theme's list", "candybar.apply.theme"],
  ])("closing ⚙ by %s closes the style list", (_how, closeWith) => {
    const rt = buildRuntime(BUNDLED);
    openDoor(rt);
    rt.clickWriting(PICKERS, "gear");
    rt.clickWriting(GEAR_PICKERS, "candybar.apply.style");
    rt.clickWriting(PICKERS, closeWith);
    expect(rt.held(GEAR_PICKERS)).toBe(DISCLOSURE_CLOSED);
  });
});

test("case 3: a lane's (?) closes with 🧪 toggles", () => {
  const rt = buildRuntime(BUNDLED);
  openDoor(rt);
  rt.clickWriting(TAB, "config");
  rt.clickWriting(PICKERS, "toggles");
  rt.clickWriting("candybar.help.experimentalBand", "open");
  rt.clickWriting(PICKERS, DISCLOSURE_CLOSED);
  rt.clickWriting(PICKERS, "toggles");
  expect(rt.held("candybar.help.experimentalBand")).toBe(DISCLOSURE_CLOSED);
});

describe("cases 4 and 5: what edit mode opened closes when it is left", () => {
  const arrange = (rt: ReturnType<typeof buildRuntime>): void => {
    openDoor(rt);
    rt.clickWriting(EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
  };

  test("case 4: a ✚'s segment library", () => {
    const rt = buildRuntime(BUNDLED);
    arrange(rt);
    rt.clickWriting("menus.edit_default_insertSeg_0.*", "edit.default.insert.0");
    const key = "menus.edit_default_insertSeg_0.edit_default_insert_0";
    expect(rt.held(key)).toBe("edit.default.insert.0");
    rt.clickWriting(EDIT_MODE_KEY, DISCLOSURE_CLOSED);
    rt.clickWriting(EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    expect(rt.held(key)).toBe(DISCLOSURE_CLOSED);
  });

  test("case 5: edit mode's (?)", () => {
    const rt = buildRuntime(BUNDLED);
    arrange(rt);
    rt.clickWriting("edit.help", "open");
    rt.clickWriting(EDIT_MODE_KEY, DISCLOSURE_CLOSED);
    rt.clickWriting(EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    expect(rt.held("edit.help")).toBe(DISCLOSURE_CLOSED);
  });

  test("case 6: closing the door leaves edit mode, and what edit mode opened", () => {
    const rt = buildRuntime(BUNDLED);
    arrange(rt);
    rt.clickWriting("edit.help", "open");
    rt.clickWriting(SETTINGS_ANCHOR, DISCLOSURE_CLOSED);
    expect(rt.held(EDIT_MODE_KEY)).toBe(DISCLOSURE_CLOSED);
    expect(rt.held("edit.help")).toBe(DISCLOSURE_CLOSED);
    expect(stripAnsi(rt.render())).not.toContain("✓ done");
  });
});


test("◁ back over a closed door restores the menu with what was open in it", () => {
  const rt = buildRuntime(BUNDLED);
  openDoor(rt);
  rt.clickWriting(TAB, "look");
  rt.clickWriting(PICKERS, "candybar.apply.effect");
  rt.clickWriting(SETTINGS_ANCHOR, DISCLOSURE_CLOSED);
  expect(rt.held(PICKERS)).toBe(DISCLOSURE_CLOSED);
  VERBS.get("back")!(SID, rt.ctx);
  expect(rt.held(SETTINGS_ANCHOR)).toBe("open");
  expect(rt.held(TAB)).toBe("look");
  expect(rt.held(PICKERS)).toBe("candybar.apply.effect");
});

test("the close is logged with what it folded", () => {
  const rt = buildRuntime(BUNDLED);
  openDoor(rt);
  rt.clickWriting(TAB, "look");
  rt.clickWriting(PICKERS, "candybar.apply.effect");
  rt.logged.length = 0;
  rt.clickWriting(TAB, "config");
  expect(rt.logged).toContain(
    `close-nested: folded=${PICKERS} (session=${SID})`,
  );
});

// The auto-close (brandon-menus-sjhy.my3) closes the door from a timer, not a
// click: a write through the closing view closes what a click would.

// A config's own groups and menus (the bundled bar has none): a group
// `outer` holding a group `inner` and a `{{ menu }}`, in an accordion with a
// group `other`.
const GROUPS = `{
  actions: { applyTheme: { set: "theme", from: "themes" } },
  segments: { picky: { template: '{{ menu "applyTheme" "▸" "▾" }}' } },
  root: { v: [
    { kind: 'group', name: 'outer', label: 'outer', key: 'acc', children: [
      { kind: 'group', name: 'inner', label: 'inner', children: ['directory'] },
      'picky',
    ] },
    { kind: 'group', name: 'other', label: 'other', key: 'acc', children: ['model'] },
  ] },
}`;
const MENU_KEY = "menus.picky.applyTheme";

describe("cases 7–9: a config's nested groups and menus", () => {
  test("case 7: a nested group closes with its parent", () => {
    const rt = buildRuntime(GROUPS);
    rt.clickWriting("acc", "outer");
    rt.clickWriting("groups.inner", "inner");
    rt.clickWriting("acc", DISCLOSURE_CLOSED);
    rt.clickWriting("acc", "outer");
    expect(rt.held("groups.inner")).toBe(DISCLOSURE_CLOSED);
  });

  test("case 8: and when the parent closes because an accordion sibling opened", () => {
    const rt = buildRuntime(GROUPS);
    rt.clickWriting("acc", "outer");
    rt.clickWriting("groups.inner", "inner");
    rt.clickWriting("acc", "other");
    expect(rt.held("groups.inner")).toBe(DISCLOSURE_CLOSED);
  });

  test("case 9: a {{ menu }} inside a group closes with the group", () => {
    const rt = buildRuntime(GROUPS);
    rt.clickWriting("acc", "outer");
    rt.clickWriting(MENU_KEY, "applyTheme");
    rt.clickWriting("acc", DISCLOSURE_CLOSED);
    rt.clickWriting("acc", "outer");
    expect(rt.held(MENU_KEY)).toBe(DISCLOSURE_CLOSED);
  });

  test("a group two levels down closes too, under one that starts open", () => {
    const rt = buildRuntime(`{ root: { v: [
      { kind: 'group', name: 'outer', label: 'outer', children: [
        { kind: 'group', name: 'middle', label: 'middle', open: true, children: [
          { kind: 'group', name: 'inner', label: 'inner', children: ['directory'] },
        ] },
      ] },
    ] } }`);
    rt.clickWriting("groups.outer", "outer");
    rt.clickWriting("groups.inner", "inner");
    rt.clickWriting("groups.outer", DISCLOSURE_CLOSED);
    rt.clickWriting("groups.outer", "outer");
    expect(rt.held("groups.inner")).toBe(DISCLOSURE_CLOSED);
    expect(rt.held("groups.middle")).toBe("middle");
  });
});
