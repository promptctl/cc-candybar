// Menus close on their own after `menuTimeout` seconds with no click, flashing
// first: the flash's schedule, the record that derives each session's close
// from its idle period, the close it makes — a click's own journaled write —
// and the flash on the rendered bar.

import { linkUrls } from "./helpers/frame";
import type { RichText } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import {
  ANIMATION_SPEED_NAMES,
  listResolvablePaletteNames,
} from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { clickUrl, effectsOf } from "./helpers/click";
import { buildRig } from "./helpers/rig";
import { linkClick } from "./helpers/click";
import { closeIdleMenus, type VerbContext } from "../src/renderer/verbs/index";
import { clickSessionOf } from "../src/click/wire";
import { instantOf, type Instant } from "../src/utils/instant";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/door";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import {
  EDIT_MODE_KEY,
  EDIT_MODE_ARRANGE,
} from "../src/config/loader/edit-mode";
import { disclosureNest } from "../src/config/disclosure-nest";
import { EDIT_LIVE_KEY } from "../src/config/edit-chrome";
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

// [LAW:no-ambient-temporal-coupling] The record reads no clock: each fact
// arrives with the instant of the turn that learned it, and the close is read
// off the record at the instant a due turn asks.
describe("MenuIdle: the close is derived from the session's record", () => {
  const drawn = (shown: boolean, timeoutS = 30) => ({ shown, timeoutS });
  const closed = (idleS = 30, timeoutS = 30) => [
    { session: S, idleS, timeoutS },
  ];

  test("a drawn menu closes a timeout after the first frame that drew it", () => {
    const idle = new MenuIdle();
    // Nothing drawn yet: no idle period is drawn.
    expect(idle.idleSince(S)).toBeNull();
    idle.drew(S, at(1000), drawn(true));
    expect(idle.idleSince(S)).toBe(1000);
    expect(idle.next()).toBe(1030);
    expect(idle.stats()).toEqual({ sessions: 1, armed: 1 });
    expect(idle.due(at(1029.9))).toEqual([]);
    expect(idle.due(at(1030))).toEqual(closed());
  });

  test("a click moves the close with no draw after it", () => {
    const idle = new MenuIdle();
    idle.drew(S, at(1000), drawn(true));
    idle.clicked(S, at(1020));
    expect(idle.next()).toBe(1050);
    expect(idle.due(at(1030))).toEqual([]);
    expect(idle.due(at(1050))).toEqual(closed());
  });

  test("a menu first drawn long after the last click closes a timeout after it appears", () => {
    const idle = new MenuIdle();
    idle.clicked(S, at(1000));
    idle.drew(S, at(1000), drawn(false));
    // A reload adds a group open by default.
    idle.drew(S, at(4600), drawn(true));
    expect(idle.idleSince(S)).toBe(4600);
    expect(idle.next()).toBe(4630);
  });

  test("a draw for an instant before the last one tells nothing", () => {
    const idle = new MenuIdle();
    // The newer frame, drawn after a ✕ click, shows no menu.
    idle.drew(S, at(1001), drawn(false));
    // A request answered behind it drew the menu, for its earlier instant.
    idle.drew(S, at(1000), drawn(true));
    expect(idle.next()).toBeNull();
    expect(idle.idleSince(S)).toBeNull();
  });

  test("a click in another session moves nothing here", () => {
    const idle = new MenuIdle();
    idle.drew(S, at(1000), drawn(true));
    idle.clicked(sessionIdOf("other"), at(1020));
    expect(idle.due(at(1030))).toEqual(closed());
  });

  test("a changed timeout is honoured", () => {
    const idle = new MenuIdle();
    idle.drew(S, at(1000), drawn(true));
    idle.drew(S, at(1010), drawn(true, 60));
    expect(idle.due(at(1030))).toEqual([]);
    expect(idle.due(at(1060))).toEqual(closed(60, 60));
  });

  test("no menu drawn, no close", () => {
    const idle = new MenuIdle();
    idle.drew(S, at(1000), drawn(true));
    idle.drew(S, at(1010), drawn(false));
    expect(idle.next()).toBeNull();
    expect(idle.stats().armed).toBe(0);
    expect(idle.due(at(1060))).toEqual([]);
  });

  // The close is shut as it is handed out, whether it then went ahead or
  // threw, so a failing close is never retried at once.
  test("a menu still drawn after a close closes a timeout later, never at once", () => {
    const idle = new MenuIdle();
    idle.drew(S, at(1000), drawn(true));
    expect(idle.due(at(1030))).toEqual(closed());
    // The draw after the close still draws a menu (a group open by default).
    idle.drew(S, at(1030), drawn(true));
    expect(idle.due(at(1059))).toEqual([]);
    expect(idle.due(at(1060))).toEqual(closed());
  });

  test("a session that stops drawing after a close is closed once, not every timeout", () => {
    const idle = new MenuIdle();
    idle.drew(S, at(1000), drawn(true));
    expect(idle.due(at(1030))).toEqual(closed());
    expect(idle.next()).toBeNull();
    expect(idle.due(at(1330))).toEqual([]);
  });

  test("a retired session's record goes with it", () => {
    const idle = new MenuIdle();
    idle.drew(S, at(1000), drawn(true));
    idle.retire(S);
    expect(idle.next()).toBeNull();
    expect(idle.stats()).toEqual({ sessions: 0, armed: 0 });
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
  const sink = new Map<string, readonly RichText[]>();
  // A frame drawn at `when`, its session idle since `idleSince`.
  const draw = (when: Instant, idleSince?: Instant) => {
    sink.clear();
    return rig.draw({
      payload: PAYLOAD,
      at: when,
      observers: { perSegmentSink: sink },
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
    expect(clickSessionOf(verb, v)).toEqual({ ok: true, id: SID });
    await clickUrl(url, ctx);
  };
  const held = (key: string): string =>
    sessionState.get(SID, key) ?? disclosureNest(config).defaultOf(key);
  return { config, draw, clickWriting, held, logged, ctx };
}

const menuRows = (frame: Frame): number =>
  frame.rows.filter((row) => row.kind === "menu").length;

const BUNDLED = `{ root: { h: ['directory', 'model'] } }`;
const IDLE = { session: SID, idleS: 30, timeoutS: 30 };

describe("the close is the write the door's ✕ makes, on a click's own path", () => {
  test("edit mode exits with the door, and its savepoint goes with it", async () => {
    const rt = idleBar(BUNDLED);
    await rt.clickWriting(SETTINGS_ANCHOR, SETTINGS_OPEN);
    await rt.clickWriting(EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    expect(rt.ctx.history.history(SID).savepoint).toBeDefined();
    closeIdleMenus(null, IDLE, rt.ctx, rt.ctx.effects);
    expect(rt.held(EDIT_MODE_KEY)).not.toBe(EDIT_MODE_ARRANGE);
    expect(rt.ctx.history.history(SID).savepoint).toBeUndefined();
  });

  test("a ✚ library open in edit mode with the door closed closes; edit mode, which drew no menu, stays", async () => {
    const rt = idleBar(`{
      segments: { arrange: { template: '{{ action "edit.toggle" "✎" }}' } },
      root: { h: ['directory', 'arrange'] },
    }`);
    const library = "menus.edit_default_insertSeg_0.edit_default_insert_0";
    await rt.clickWriting(EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    await rt.clickWriting(library, "edit.default.insert.0");
    expect(rt.held(SETTINGS_ANCHOR)).toBe(DISCLOSURE_CLOSED);
    expect(menuRows(rt.draw(instantOf(new Date())))).toBeGreaterThan(0);
    closeIdleMenus(null, IDLE, rt.ctx, rt.ctx.effects);
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
    closeIdleMenus(null, IDLE, rt.ctx, rt.ctx.effects);
    expect(rt.held(SETTINGS_ANCHOR)).toBe(DISCLOSURE_CLOSED);
    expect(rt.held(EDIT_LIVE_KEY)).toBe("open");
  });

  test("a group open by default is closed, and stays closed", async () => {
    const rt = idleBar(`{ root: { v: [
      { kind: 'group', name: 'more', label: 'more', open: true, children: ['model'] },
      'directory',
    ] } }`);
    expect(rt.held("groups.more")).toBe("more");
    closeIdleMenus(null, IDLE, rt.ctx, rt.ctx.effects);
    expect(rt.held("groups.more")).toBe(DISCLOSURE_CLOSED);
    expect(menuRows(rt.draw(instantOf(new Date())))).toBe(0);
  });

  test("with nothing open it writes nothing, and says so", async () => {
    const rt = idleBar(BUNDLED);
    closeIdleMenus(null, IDLE, rt.ctx, rt.ctx.effects);
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
