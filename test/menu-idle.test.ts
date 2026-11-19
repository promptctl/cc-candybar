// Menus close on their own after `menuTimeout` seconds with no click, flashing
// first (brandon-menus-sjhy.my3): the flash's schedule, each session's idle
// period as the renderer keeps it on its ticks, the close it makes — a click's
// own journaled write — and the flash on the rendered bar.

import { linkUrls } from "./helpers/frame";
import { parseAndValidate } from "./helpers/parse-and-validate";
import {
  ANIMATION_SPEED_NAMES,
  listResolvablePaletteNames,
} from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { clickUrl, effectsOf, bookedContext, CLICK_VERBS } from "./helpers/click";
import { buildRig } from "./helpers/rig";
import { linkClick } from "./helpers/click";
import { closeIdleMenus, type VerbContext } from "../src/renderer/verbs/index";
import { admitClick } from "../src/click/wire";
import { instantOf, type Instant, type Tick } from "../src/utils/instant";
import {
  sessionIdOf,
  type SessionId,
} from "../src/daemon/foundations/session-id";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/door";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import {
  EDIT_MODE_KEY,
  EDIT_MODE_ARRANGE,
} from "../src/config/loader/edit-mode";
import { disclosureNest } from "../src/config/disclosure-nest";
import { EDIT_LIVE_KEY, insertGap } from "../src/config/edit-chrome";
import {
  CLOSING_FLASH_SECONDS,
  MENU_TIMEOUT_RANGE,
  flashBegins,
  litAt,
} from "../src/config/menu-timeout";
import { MenuIdle } from "../src/renderer/menu-idle";
import { selectionFor } from "./helpers/selection";
import { textOf, type Frame, type Row } from "../src/render/frame";

const at = (s: number): Instant => s as Instant;
const S = sessionIdOf("s");

describe("the flash", () => {
  test("three slow flashes, then three fast ones, ending where the menu closes", () => {
    expect(CLOSING_FLASH_SECONDS).toBe(7.5);
    expect(MENU_TIMEOUT_RANGE.min).toBeGreaterThan(CLOSING_FLASH_SECONDS);
    // A 30 s timeout closes 30 s into the idle period, flashing from 22.5 s.
    expect(flashBegins(30)).toBe(22.5);
    expect(flashBegins(30) + CLOSING_FLASH_SECONDS).toBe(30);
    const lit = [
      0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.1, 6.4, 6.6, 6.9, 7.1, 7.4,
    ].map(litAt);
    expect(lit).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
  });
});

describe("the idle period: a close is due a timeout after it began, while a menu shows", () => {
  const tick = (s: number) => s as Tick;
  const T = sessionIdOf("t");

  test("a drawn menu is due a timeout after the first draw that showed it", () => {
    const idle = new MenuIdle();
    idle.drew(S, tick(10), true, 30);
    idle.drew(S, tick(20), true, 30);
    expect(idle.next()).toBe(40);
    expect(idle.due(tick(39))).toEqual([]);
    expect(idle.due(tick(40))).toEqual([
      { session: S, idle: { idleS: 30, timeoutS: 30 } },
    ]);
  });

  test("a click begins a new period, with no draw after it; another session's click moves nothing here", () => {
    const idle = new MenuIdle();
    idle.drew(S, tick(0), true, 30);
    idle.drew(T, tick(0), true, 30);
    idle.clicked(T, tick(25));
    expect(idle.next()).toBe(30);
    idle.clicked(S, tick(25));
    expect(idle.next()).toBe(55);
  });

  test("a session with a pending click retains its idle deadline while another expires", () => {
    const idle = new MenuIdle();
    const busy = new Set([S]);
    idle.drew(S, tick(0), true, 30);
    idle.drew(T, tick(0), true, 30);
    expect(idle.due(tick(30), busy)).toEqual([
      { session: T, idle: { idleS: 30, timeoutS: 30 } },
    ]);
    expect(idle.next(busy)).toBeNull();
    expect(idle.next()).toBe(30);
  });

  test("a menu first shown long after the last click is due a timeout after it appears", () => {
    const idle = new MenuIdle();
    idle.drew(S, tick(0), false, 30);
    idle.clicked(S, tick(1));
    idle.drew(S, tick(100), true, 30);
    expect(idle.next()).toBe(130);
  });

  test("a click of a session that has never drawn makes no record", () => {
    const idle = new MenuIdle();
    idle.clicked(S, tick(5));
    expect(idle.stats()).toEqual({ sessions: 0, armed: 0 });
    expect(idle.next()).toBeNull();
  });

  test("a changed timeout is honoured, and with no menu shown nothing is due", () => {
    const idle = new MenuIdle();
    idle.drew(S, tick(0), true, 30);
    idle.drew(S, tick(1), true, 60);
    expect(idle.next()).toBe(60);
    idle.drew(S, tick(2), false, 60);
    expect(idle.next()).toBeNull();
    expect(idle.due(tick(1000))).toEqual([]);
    expect(idle.stats()).toEqual({ sessions: 1, armed: 0 });
  });

  test("a close is taken once: a new period begins, so a menu still shown is due a timeout later, and a session that stops drawing is never closed again", () => {
    const idle = new MenuIdle();
    idle.drew(S, tick(0), true, 30);
    expect(idle.due(tick(31))).toHaveLength(1);
    expect(idle.due(tick(1000))).toEqual([]);
    // The menu outlived its close (the close failed): due a timeout on.
    idle.drew(S, tick(1001), true, 30);
    expect(idle.next()).toBe(1031);
  });

  test("the period's start is read on the wall each draw is made on, so the flash ends where the close lands however the wall stepped", () => {
    const idle = new MenuIdle();
    expect(idle.since(S, { at: at(500), tick: tick(0) })).toBeNull();
    idle.drew(S, tick(10), true, 30);
    // Ten seconds of ticks on: the period began ten seconds before the wall.
    expect(idle.since(S, { at: at(500), tick: tick(20) })).toBe(490);
    // The wall stepped back an hour; the period is still ten seconds old.
    expect(idle.since(S, { at: at(500 - 3600), tick: tick(20) })).toBe(
      500 - 3600 - 10,
    );
    idle.retire(S);
    expect(idle.since(S, { at: at(500), tick: tick(20) })).toBeNull();
    expect(idle.next()).toBeNull();
  });
});

const ALLOWED = new Set(listResolvablePaletteNames());
const SID = sessionIdOf("s1");
const TAB = "candybar.tab";
const PICKERS = "menus.candybar_pickers";
const PAYLOAD = {
  session_id: SID,
  tmux: { pane: "%0" },
  project_dir: "/tmp/proj",
  workspace: { current_dir: "/tmp/proj" },
  model: { display_name: "Opus" },
};

// The bar with its menus: the rig keeps the session's render origin, as every
// session has one before a click, and this file owns which link it clicks and
// the log its close writes.
function idleBar(src: string) {
  const rig = buildRig({
    source: src,
    label: "<user>",
    base: DEFAULT_DSL_CONFIG,
    palettes: ALLOWED,
    sessionId: SID,
  });
  const { config, sessionState } = rig;
  // A frame drawn at `when`, its session idle since `idleSince`.
  const draw = (when: Instant, idleSince?: Instant) => {
    return rig.draw({
      payload: PAYLOAD,
      at: when,
      selection: selectionFor(
        config,
        idleSince === undefined ? {} : { idleSince },
      ),
    }).frame;
  };
  const logged: string[] = [];
  const ctx: VerbContext = {
    ...rig.ctx,
    configFor: () => config,
    log: (_level, line) => logged.push(line),
  };
  const clickWriting = async (key: string, value: string): Promise<void> => {
    const url = linkUrls(draw(instantOf(new Date()))).find((u) =>
      effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value),
    );
    if (!url) throw new Error(`no affordance writing ${key}=${value} rendered`);
    const { verb, value: v } = linkClick(url);
    expect(admitClick(verb, v)).toMatchObject({ scope: "session", session: SID });
    await clickUrl(url, ctx);
  };
  const held = (key: string): string =>
    ctx.edits.view.get(SID, key) ?? disclosureNest(config).defaultOf(key);
  return { config, draw, clickWriting, held, logged, ctx };
}

const menuRows = (frame: Frame): number =>
  frame.rows.filter((row) => row.kind === "menu").length;

const BUNDLED = `{ root: { h: ['directory', 'model'] } }`;
const IDLE = { idleS: 30, timeoutS: 30 };

describe("the close is the write the door's ✕ makes, on a click's own path", () => {
  test("idle closure preserves a changed draft; Back cannot restore a discarded transaction", async () => {
    const rt = idleBar(BUNDLED);
    await rt.clickWriting(SETTINGS_ANCHOR, SETTINGS_OPEN);
    await rt.clickWriting(EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    await CLICK_VERBS.get("set-state")!(`${SID}/theme/nord`, rt.ctx);
    expect(rt.ctx.edits.draft(SID)).not.toBeNull();
    await closeIdleMenus(
      SID,
      bookedContext(rt.ctx.sessionState, SID),
      IDLE,
      rt.ctx,
      rt.ctx.effects,
    );
    expect(rt.held(EDIT_MODE_KEY)).toBe(EDIT_MODE_ARRANGE);
    expect(rt.ctx.edits.draft(SID)).not.toBeNull();
    await rt.clickWriting(SETTINGS_ANCHOR, DISCLOSURE_CLOSED);
    expect(rt.held(EDIT_MODE_KEY)).not.toBe(EDIT_MODE_ARRANGE);
    expect(rt.ctx.edits.draft(SID)).toBeNull();
    await CLICK_VERBS.get("back")!(SID, rt.ctx);
    expect(rt.held(SETTINGS_ANCHOR)).toBe(SETTINGS_OPEN);
    expect(rt.ctx.edits.draft(SID)).toBeNull();
  });

  test("a ✚ library open in edit mode with the door closed closes; edit mode, which drew no menu, stays", async () => {
    const rt = idleBar(`{
      segments: { arrange: { template: '{{ action "edit.toggle" "✎" }}' } },
      root: { h: ['directory', 'arrange'] },
    }`);
    const gap = insertGap("default", "directory", "before");
    const library = gap.stateKey;
    await rt.clickWriting(EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    await rt.clickWriting(library, gap.apply);
    expect(rt.held(SETTINGS_ANCHOR)).toBe(DISCLOSURE_CLOSED);
    expect(menuRows(rt.draw(instantOf(new Date())))).toBeGreaterThan(0);
    await closeIdleMenus(
      SID,
      bookedContext(rt.ctx.sessionState, SID),
      IDLE,
      rt.ctx,
      rt.ctx.effects,
    );
    expect(rt.held(library)).toBe(DISCLOSURE_CLOSED);
    expect(rt.held(EDIT_MODE_KEY)).toBe(EDIT_MODE_ARRANGE);
    expect(menuRows(rt.draw(instantOf(new Date())))).toBe(0);
    expect(rt.logged).toContain(
      `menu-idle: closed=${library} idle=30.0s timeout=30s (session=${SID})`,
    );
  });

  test("a toggle that hangs no menu is a view preference, and is left as it is", async () => {
    const rt = idleBar(BUNDLED);
    await rt.clickWriting(SETTINGS_ANCHOR, SETTINGS_OPEN);
    await rt.clickWriting(EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    await rt.clickWriting(EDIT_LIVE_KEY, "open");
    await closeIdleMenus(
      SID,
      bookedContext(rt.ctx.sessionState, SID),
      IDLE,
      rt.ctx,
      rt.ctx.effects,
    );
    expect(rt.held(SETTINGS_ANCHOR)).toBe(DISCLOSURE_CLOSED);
    expect(rt.held(EDIT_LIVE_KEY)).toBe("open");
  });

  test("a group open by default is closed, and stays closed", async () => {
    const rt = idleBar(`{ root: { v: [
      { kind: 'group', name: 'more', label: 'more', open: true, children: ['model'] },
      'directory',
    ] } }`);
    expect(rt.held("groups.more")).toBe("more");
    await closeIdleMenus(
      SID,
      bookedContext(rt.ctx.sessionState, SID),
      IDLE,
      rt.ctx,
      rt.ctx.effects,
    );
    expect(rt.held("groups.more")).toBe(DISCLOSURE_CLOSED);
    expect(menuRows(rt.draw(instantOf(new Date())))).toBe(0);
  });

  test("with nothing open it writes nothing, and says so", async () => {
    const rt = idleBar(BUNDLED);
    await closeIdleMenus(
      SID,
      bookedContext(rt.ctx.sessionState, SID),
      IDLE,
      rt.ctx,
      rt.ctx.effects,
    );
    expect(rt.held(SETTINGS_ANCHOR)).toBe(DISCLOSURE_CLOSED);
    expect(rt.logged).toContain(
      `menu-idle: closed=- idle=30.0s timeout=30s (session=${SID})`,
    );
  });
});

describe("the flash on the bar", () => {
  // Idle since 1000, closing at 1120: the first slow flash is lit from 1112.5.
  const SINCE = at(1000);
  const LIT = at(1113);
  const DARK = at(1114);
  const BEFORE = at(1010);

  test("menu rows light while lit; bar rows never do", async () => {
    const rt = idleBar(BUNDLED);
    await rt.clickWriting(SETTINGS_ANCHOR, SETTINGS_OPEN);
    const calm = rt.draw(LIT);
    const lit = rt.draw(LIT, SINCE);
    expect(menuRows(calm)).toBeGreaterThan(0);
    const bar = calm.rows.filter((row) => row.kind === "bar").length;
    // The risen door's rows stack over the bar's: the bar is the last rows.
    expect(lit.rows.slice(-bar)).toEqual(calm.rows.slice(-bar));
    const menu = ({ rows }: Frame) => rows.slice(0, -bar);
    expect(menu(lit)).not.toEqual(menu(calm));
    // Light changes colour, never the words.
    expect(textOf(lit)).toBe(textOf(calm));
    expect(lit.motion).toBe("moves");
    // Lit, a menu row is one colour: every cell on the flash's fill.
    const grounds = ({ runs }: Row): Set<string> =>
      new Set(runs.flatMap(({ bg }) => bg ?? []));
    for (const row of menu(lit)) expect(grounds(row).size).toBe(1);
    expect(grounds(menu(calm)[0]!).size).toBeGreaterThan(1);
  });

  test("dark between flashes, and before the flash begins, the bar is as it was", async () => {
    const rt = idleBar(BUNDLED);
    await rt.clickWriting(SETTINGS_ANCHOR, SETTINGS_OPEN);
    expect(rt.draw(DARK, SINCE).rows).toEqual(rt.draw(DARK).rows);
    const waiting = rt.draw(BEFORE, SINCE);
    expect(waiting.rows).toEqual(rt.draw(BEFORE).rows);
    // Drawn as it was, yet it says when it changes: the flash's first lit hold
    // (candybar-animation-wbxz.014), so a feed drawing it is drawn then.
    expect(waiting.motion).toBe("moves");
    expect(waiting.nextChange).toBe(1112.5);
    // The same frame between two holds says when the next one turns.
    expect(rt.draw(DARK, SINCE).nextChange).toBe(1114.5);
  });

  // The flash counts down to the moment the daemon's timer closes the menus,
  // so its holds are on the host clock however fast the session animates.
  test("the flash begins and turns at the same host instant at every animation speed", async () => {
    for (const speed of ANIMATION_SPEED_NAMES) {
      const rt = idleBar(
        `{ globals: { animationSpeed: "${speed}" }, root: { h: ['directory', 'model'] } }`,
      );
      await rt.clickWriting(SETTINGS_ANCHOR, SETTINGS_OPEN);
      expect([speed, rt.draw(BEFORE, SINCE).nextChange]).toEqual([
        speed,
        1112.5,
      ]);
      expect([speed, rt.draw(DARK, SINCE).nextChange]).toEqual([speed, 1114.5]);
    }
  });

  test("a menu the frame first draws, its idle period not begun, can move but says no change", async () => {
    const rt = idleBar(BUNDLED);
    await rt.clickWriting(SETTINGS_ANCHOR, SETTINGS_OPEN);
    const opened = rt.draw(BEFORE);
    expect(opened.nextChange).toBe(Infinity);
    expect(opened.motion).toBe("can-move");
  });

  test("a bar with no menu open draws no menu rows, and never flashes", () => {
    const rt = idleBar(BUNDLED);
    const frame = rt.draw(LIT, SINCE);
    expect(menuRows(frame)).toBe(0);
    expect(frame.rows).toEqual(rt.draw(LIT).rows);
    expect(frame.motion).toBe("still");
  });
});
