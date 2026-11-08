// brandon-menus-sjhy.9p6: when a parent menu closes, every sub-menu inside it
// closes with it. One test per case on the ticket's case list (comment
// cmt-b97df8ef), each clicking the links the bar renders through the verbs the
// daemon runs, then reopening the parent to find the child closed.

import { textOf } from "../src/render/frame";
import type { Frame } from "../src/render/frame";
import { linkUrls } from "./helpers/frame";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { clickUrl, effectsOf, clickEffect } from "./helpers/click";
import { buildRig } from "./helpers/rig";
import { type VerbContext } from "../src/daemon/verbs";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import {
  EDIT_CONFIGURE_KEY,
  EDIT_MODE_KEY,
  EDIT_MODE_ARRANGE,
  configureMember,
} from "../src/config/loader/edit-mode";
import { disclosureNest } from "../src/config/disclosure-nest";
import { closingView } from "../src/daemon/closing-view";
import { chromeIdent } from "../src/config/edit-chrome";
import { menuStateKey } from "../src/config/menu-keys";
import { SessionState, SINGLE_RUN } from "../src/daemon/session-state";
import type { DslConfig } from "../src/config/dsl-types";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";

const SID = "s1";
const PALETTES = new Set(listResolvablePaletteNames());
const TAB = "candybar.tab";
const PICKERS = "menus.candybar_pickers";
const GEAR_PICKERS = "menus.candybar_gearPickers";
const PAYLOAD = {
  session_id: SID,
  tmux: { pane: "%0" },
  project_dir: "/tmp/proj",
  workspace: { current_dir: "/tmp/proj" },
  model: { display_name: "Opus" },
};

// With `durable`, the bar's config is that file's: a click that edits the
// layout writes it and reloads from it, as the daemon's render cache does.
function nestBar(src: string, durable?: DurableConfig) {
  const sessionState = new SessionState(SINGLE_RUN);
  durable?.seedOrigin(sessionState, SID);
  const rig = buildRig({
    source: src,
    label: "<user>",
    base: DEFAULT_DSL_CONFIG,
    sessionState,
    ...(durable && { history: durable.historyFor(sessionState), host: durable.host }),
  });
  const { config } = rig;
  const render = (): Frame => rig.draw({ payload: PAYLOAD }).frame;
  const logged: string[] = [];
  let current: DslConfig = config;
  // The daemon's reload: the session's config becomes the file's text, after
  // a click's write and after a hand edit alike.
  const reload = (file: DurableConfig): void => {
    current = parseAndValidate("<reloaded>", file.text()!, PALETTES, DEFAULT_DSL_CONFIG);
  };
  const ctx: VerbContext = {
    ...rig.ctx,
    log: (_level, line) => logged.push(line),
    ...(durable && {
      configFor: () => current,
      reloadConfig: () => reload(durable),
    }),
  };
  // One click is one verb call, as the daemon runs it.
  const click = (url: string): Promise<void> => clickUrl(url, ctx);
  // Click the affordance whose URL writes `value` to a key `key` names
  // (exactly, or as a prefix ending in `*`), wherever it landed.
  const clickWriting = async (key: string, value: string): Promise<void> => {
    const matches = (k: string): boolean =>
      key.endsWith("*") ? k.startsWith(key.slice(0, -1)) : k === key;
    const url = linkUrls(render()).find((u) =>
      effectsOf(u).some((e) => matches(e.args[1] ?? "") && e.args[2] === value),
    );
    if (!url) throw new Error(`no affordance writing ${key}=${value} rendered`);
    await click(url);
  };
  // What the session reads: a cleared key holds its state variable's default.
  const held = (key: string): string =>
    sessionState.get(SID, key) ?? disclosureNest(config).defaultOf(key);
  // Click the first affordance one of whose effects carries a value `value` accepts.
  const clickDoing = async (value: (v: string) => boolean): Promise<void> => {
    const url = linkUrls(render()).find((u) => effectsOf(u).some((e) => value(e.args[2] ?? "")));
    if (!url) throw new Error("no such affordance rendered");
    await click(url);
  };
  return { config, sessionState, render, clickWriting, clickDoing, held, logged, ctx, reload };
}

const BUNDLED = `{ root: { h: ['directory', 'model'] } }`;
// The `+` before the row's first content, `directory`: its menu's apply action
// and the state key that holds the library open.
const LIBRARY_APPLY = `edit.default.insert.before.${chromeIdent("directory")}`;
const LIBRARY = menuStateKey(
  `edit.default.insertSeg.before.${chromeIdent("directory")}`,
  LIBRARY_APPLY,
  undefined,
);
const openDoor = async (rt: ReturnType<typeof nestBar>): Promise<void> =>
  await rt.clickWriting(SETTINGS_ANCHOR, "open");

describe("case 1: a tab's lists and submenus close with the tab", () => {
  test.each([
    ["its trigger", async (rt: ReturnType<typeof nestBar>) => await rt.clickWriting(TAB, DISCLOSURE_CLOSED)],
    ["opening another tab", async (rt: ReturnType<typeof nestBar>) => await rt.clickWriting(TAB, "config")],
  ])("the effect list, closing 🎨 look by %s", async (_how, close) => {
    const rt = nestBar(BUNDLED);
    await openDoor(rt);
    await rt.clickWriting(TAB, "look");
    await rt.clickWriting(PICKERS, "candybar.apply.effect");
    await close(rt);
    await rt.clickWriting(TAB, "look");
    expect(rt.held(PICKERS)).toBe(DISCLOSURE_CLOSED);
  });

  test("🧪 toggles, closing ⚙ config by opening ⚡ session", async () => {
    const rt = nestBar(BUNDLED);
    await openDoor(rt);
    await rt.clickWriting(TAB, "config");
    await rt.clickWriting(PICKERS, "toggles");
    await rt.clickWriting(TAB, "session");
    expect(rt.held(PICKERS)).toBe(DISCLOSURE_CLOSED);
  });

  test("a list on the door's own line stays open when a tab closes: one key, held outside the tab", async () => {
    const rt = nestBar(BUNDLED);
    await openDoor(rt);
    await rt.clickWriting(TAB, "look");
    await rt.clickWriting(PICKERS, "candybar.apply.theme");
    await rt.clickWriting(TAB, "config");
    expect(rt.held(PICKERS)).toBe("candybar.apply.theme");
  });
});

describe("case 2: the gear's lists close with the gear", () => {
  test.each([
    ["its trigger", DISCLOSURE_CLOSED],
    ["opening 🎨 theme's list", "candybar.apply.theme"],
  ])("closing ⚙ by %s closes the style list", async (_how, closeWith) => {
    const rt = nestBar(BUNDLED);
    await openDoor(rt);
    await rt.clickWriting(PICKERS, "gear");
    await rt.clickWriting(GEAR_PICKERS, "candybar.apply.style");
    await rt.clickWriting(PICKERS, closeWith);
    expect(rt.held(GEAR_PICKERS)).toBe(DISCLOSURE_CLOSED);
  });
});

test("case 3: a lane's (?) closes with 🧪 toggles", async () => {
  const rt = nestBar(BUNDLED);
  await openDoor(rt);
  await rt.clickWriting(TAB, "config");
  await rt.clickWriting(PICKERS, "toggles");
  await rt.clickWriting("candybar.help.experimentalBand", "open");
  await rt.clickWriting(PICKERS, DISCLOSURE_CLOSED);
  await rt.clickWriting(PICKERS, "toggles");
  expect(rt.held("candybar.help.experimentalBand")).toBe(DISCLOSURE_CLOSED);
});

describe("cases 4 and 5: what edit mode opened closes when it is left", () => {
  const arrange = async (rt: ReturnType<typeof nestBar>): Promise<void> => {
    await openDoor(rt);
    await rt.clickWriting(EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
  };

  test("case 4: a ✚'s segment library", async () => {
    const rt = nestBar(BUNDLED);
    await arrange(rt);
    await rt.clickWriting(LIBRARY, LIBRARY_APPLY);
    expect(rt.held(LIBRARY)).toBe(LIBRARY_APPLY);
    await rt.clickWriting(EDIT_MODE_KEY, DISCLOSURE_CLOSED);
    await rt.clickWriting(EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    expect(rt.held(LIBRARY)).toBe(DISCLOSURE_CLOSED);
  });

  // A layout edit that ends a ✚'s gap (a pick at the row's leading ✚ renames
  // it after the new first content; removing its anchor ends it) releases the
  // library's key in the same click: nothing closes a key no config declares.
  // A gap the edit keeps keeps its library open for the next pick.
  describe("a layout edit and the libraries beside it", () => {
    let durable: DurableConfig;
    beforeEach(() => {
      durable = durableConfig("cc-candybar-nest-");
      durable.write(BUNDLED);
    });
    afterEach(() => durable.dispose());
    const AFTER_APPLY = `edit.default.insert.after.${chromeIdent("directory")}`;
    const AFTER = menuStateKey(
      `edit.default.insertSeg.after.${chromeIdent("directory")}`,
      AFTER_APPLY,
      undefined,
    );
    // The anchor's id is placed in no other preset's tree, so a re-add of
    // `directory` beside it takes the freed id rather than `directory-2`.
    const ANCHORED = `{ root: { h: ['directory', { seg: 'model', id: 'anchor' }] } }`;
    const ANCHOR_APPLY = `edit.default.insert.after.${chromeIdent("anchor")}`;
    const ANCHOR_LIBRARY = menuStateKey(
      `edit.default.insertSeg.after.${chromeIdent("anchor")}`,
      ANCHOR_APPLY,
      undefined,
    );

    test("a pick at the row's leading ✚ lands and closes its library", async () => {
      const rt = nestBar(BUNDLED, durable);
      await arrange(rt);
      await rt.clickWriting(LIBRARY, LIBRARY_APPLY);
      await rt.clickDoing((v) => v.endsWith(":directory:before"));
      expect(rt.sessionState.get(SID, LIBRARY)).toBeNull();
    });

    test("a pick after a placement keeps its library open", async () => {
      const rt = nestBar(BUNDLED, durable);
      await arrange(rt);
      await rt.clickWriting(AFTER, AFTER_APPLY);
      await rt.clickDoing((v) => v.endsWith(":directory:after"));
      expect(rt.sessionState.get(SID, AFTER)).toBe(AFTER_APPLY);
    });

    test("removing a placement closes the library its gap opened", async () => {
      const rt = nestBar(BUNDLED, durable);
      await arrange(rt);
      await rt.clickWriting(AFTER, AFTER_APPLY);
      await rt.clickDoing((v) => v === "remove:directory");
      expect(rt.sessionState.get(SID, AFTER)).toBeNull();
    });

    test("a placement re-added under a removed one's id finds its library closed", async () => {
      durable.write(ANCHORED);
      const rt = nestBar(ANCHORED, durable);
      await arrange(rt);
      await rt.clickWriting(AFTER, AFTER_APPLY);
      await rt.clickDoing((v) => v === "remove:directory");
      await rt.clickWriting(ANCHOR_LIBRARY, ANCHOR_APPLY);
      await rt.clickDoing((v) => v === "insert:directory:anchor:after");
      expect(rt.logged.join("\n")).toContain('placed={"seg":"directory"}');
      expect(rt.held(AFTER)).toBe(DISCLOSURE_CLOSED);
    });

    // A hand edit ends the placement outside any click, so its library's key
    // outlives it; the click that re-adds the id begins that key again.
    test("a placement removed by hand and re-added under its id finds its library closed", async () => {
      durable.write(ANCHORED);
      const rt = nestBar(ANCHORED, durable);
      await arrange(rt);
      await rt.clickWriting(AFTER, AFTER_APPLY);
      expect(rt.held(AFTER)).toBe(AFTER_APPLY);
      durable.write(`{ root: { h: [{ seg: 'model', id: 'anchor' }] } }`);
      rt.reload(durable);
      await rt.clickWriting(ANCHOR_LIBRARY, ANCHOR_APPLY);
      expect(rt.held(AFTER)).toBe(AFTER_APPLY);
      await rt.clickDoing((v) => v === "insert:directory:anchor:after");
      expect(rt.logged.join("\n")).toContain('placed={"seg":"directory"}');
      expect(rt.held(AFTER)).toBe(DISCLOSURE_CLOSED);
    });

    // The configure key is declared by every config, so only its value's
    // admission tells the edits apart: the hand edit leaves the member it
    // stopped admitting, and the re-add admits it again.
    test("a placement configured, removed by hand and re-added under its id is not configuring", async () => {
      const configuring = configureMember("default", "directory");
      durable.write(ANCHORED);
      const rt = nestBar(ANCHORED, durable);
      await arrange(rt);
      await rt.clickWriting(EDIT_CONFIGURE_KEY, configuring);
      expect(rt.held(EDIT_CONFIGURE_KEY)).toBe(configuring);
      durable.write(`{ root: { h: [{ seg: 'model', id: 'anchor' }] } }`);
      rt.reload(durable);
      await rt.clickWriting(ANCHOR_LIBRARY, ANCHOR_APPLY);
      expect(rt.held(EDIT_CONFIGURE_KEY)).toBe(configuring);
      await rt.clickDoing((v) => v === "insert:directory:anchor:after");
      expect(rt.logged.join("\n")).toContain('placed={"seg":"directory"}');
      expect(rt.held(EDIT_CONFIGURE_KEY)).toBe(DISCLOSURE_CLOSED);
    });
  });

  test("case 5: edit mode's (?)", async () => {
    const rt = nestBar(BUNDLED);
    await arrange(rt);
    await rt.clickWriting("edit.help", "open");
    await rt.clickWriting(EDIT_MODE_KEY, DISCLOSURE_CLOSED);
    await rt.clickWriting(EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    expect(rt.held("edit.help")).toBe(DISCLOSURE_CLOSED);
  });

  test("case 6: closing the door leaves edit mode, and what edit mode opened", async () => {
    const rt = nestBar(BUNDLED);
    await arrange(rt);
    await rt.clickWriting("edit.help", "open");
    await rt.clickWriting(SETTINGS_ANCHOR, DISCLOSURE_CLOSED);
    expect(rt.held(EDIT_MODE_KEY)).toBe(DISCLOSURE_CLOSED);
    expect(rt.held("edit.help")).toBe(DISCLOSURE_CLOSED);
    expect(textOf(rt.render())).not.toContain("✓ done");
  });
});


test("◁ back over a closed door restores the menu with what was open in it", async () => {
  const rt = nestBar(BUNDLED);
  await openDoor(rt);
  await rt.clickWriting(TAB, "look");
  await rt.clickWriting(PICKERS, "candybar.apply.effect");
  await rt.clickWriting(SETTINGS_ANCHOR, DISCLOSURE_CLOSED);
  expect(rt.held(PICKERS)).toBe(DISCLOSURE_CLOSED);
  await clickEffect("back", SID, rt.ctx);
  expect(rt.held(SETTINGS_ANCHOR)).toBe("open");
  expect(rt.held(TAB)).toBe("look");
  expect(rt.held(PICKERS)).toBe("candybar.apply.effect");
});

test("the close is logged with what it folded", async () => {
  const rt = nestBar(BUNDLED);
  await openDoor(rt);
  await rt.clickWriting(TAB, "look");
  await rt.clickWriting(PICKERS, "candybar.apply.effect");
  rt.logged.length = 0;
  await rt.clickWriting(TAB, "config");
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
  test("case 7: a nested group closes with its parent", async () => {
    const rt = nestBar(GROUPS);
    await rt.clickWriting("acc", "outer");
    await rt.clickWriting("groups.inner", "inner");
    await rt.clickWriting("acc", DISCLOSURE_CLOSED);
    await rt.clickWriting("acc", "outer");
    expect(rt.held("groups.inner")).toBe(DISCLOSURE_CLOSED);
  });

  test("case 8: and when the parent closes because an accordion sibling opened", async () => {
    const rt = nestBar(GROUPS);
    await rt.clickWriting("acc", "outer");
    await rt.clickWriting("groups.inner", "inner");
    await rt.clickWriting("acc", "other");
    expect(rt.held("groups.inner")).toBe(DISCLOSURE_CLOSED);
  });

  test("case 9: a {{ menu }} inside a group closes with the group", async () => {
    const rt = nestBar(GROUPS);
    await rt.clickWriting("acc", "outer");
    await rt.clickWriting(MENU_KEY, "applyTheme");
    await rt.clickWriting("acc", DISCLOSURE_CLOSED);
    await rt.clickWriting("acc", "outer");
    expect(rt.held(MENU_KEY)).toBe(DISCLOSURE_CLOSED);
  });

  test("a group two levels down closes too, under one that starts open", async () => {
    const rt = nestBar(`{ root: { v: [
      { kind: 'group', name: 'outer', label: 'outer', children: [
        { kind: 'group', name: 'middle', label: 'middle', open: true, children: [
          { kind: 'group', name: 'inner', label: 'inner', children: ['directory'] },
        ] },
      ] },
    ] } }`);
    await rt.clickWriting("groups.outer", "outer");
    await rt.clickWriting("groups.inner", "inner");
    await rt.clickWriting("groups.outer", DISCLOSURE_CLOSED);
    await rt.clickWriting("groups.outer", "outer");
    expect(rt.held("groups.inner")).toBe(DISCLOSURE_CLOSED);
    expect(rt.held("groups.middle")).toBe("middle");
  });
});
