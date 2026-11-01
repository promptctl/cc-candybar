// Menus close on their own after `menuTimeout` seconds with no click, flashing
// first (brandon-menus-sjhy.my3): the flash's schedule, the timer that follows
// each session's idle clock, the close it makes — a click's own journaled
// write — and the flash on the rendered bar.

import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import type { RichText } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { drawPayload, registerDslConfig } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import {
  ANIMATION_SPEED_NAMES,
  listResolvablePaletteNames,
} from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import {
  VERBS,
  SESSION_RENDER_ORIGIN_KEY,
  encodeRenderOrigin,
  closeIdleMenus,
  clickSessionOf,
  type VerbContext,
} from "../src/daemon/verbs/index";
import { linkUrls, stripAnsi } from "./helpers/ansi";
import { instantOf, type Instant } from "../src/utils/instant";
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
import { MenuIdle } from "../src/daemon/menu-idle";
import { selectionFor } from "./helpers/selection";

const at = (s: number): Instant => s as Instant;

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

describe("MenuIdle: the close follows the idle clock, whoever writes it", () => {
  let now = 0;
  let closes: Array<{ sid: string; idleS: number; timeoutS: number }>;
  let failures: string[];
  let idle: MenuIdle;
  beforeEach(() => {
    jest.useFakeTimers();
    now = 1000;
    closes = [];
    failures = [];
    idle = new MenuIdle({
      now: () => at(now),
      close: async (sid, { idleS, timeoutS }) => {
        closes.push({ sid, idleS, timeoutS });
      },
      failed: (sid, e) => failures.push(`${sid}: ${String(e)}`),
    });
  });
  afterEach(() => {
    idle.dispose();
    jest.useRealTimers();
  });
  const advance = (s: number): void => {
    now += s;
    jest.advanceTimersByTime(s * 1000);
  };

  test("a drawn menu closes a timeout after the first frame that drew it", () => {
    // Nothing drawn yet: a frame drawing a menu now has only begun it.
    expect(idle.since("s", at(now))).toBeUndefined();
    idle.observe("s", at(now), true, 30);
    expect(idle.since("s", at(now))).toBe(1000);
    expect(idle.getStats().armed).toBe(1);
    advance(29.9);
    expect(closes).toEqual([]);
    advance(0.1);
    expect(closes).toEqual([{ sid: "s", idleS: 30, timeoutS: 30 }]);
  });

  // [LAW:no-ambient-temporal-coupling] A render that was awaiting as the daemon
  // closed lands here: disposed, it arms nothing.
  test("a frame landing after dispose arms no close", () => {
    idle.dispose();
    idle.observe("s1", at(now), true, 30);
    expect(idle.getStats().armed).toBe(0);
    advance(31);
    expect(closes).toEqual([]);
  });

  test("a click moves the close with no render after it", () => {
    idle.observe("s", at(now), true, 30);
    advance(20);
    idle.clicked("s", at(now));
    advance(10);
    expect(closes).toEqual([]);
    advance(20);
    expect(closes).toEqual([{ sid: "s", idleS: 30, timeoutS: 30 }]);
  });

  test("a menu first drawn long after the last click closes a timeout after it appears", () => {
    idle.clicked("s", at(now));
    idle.observe("s", at(now), false, 30);
    advance(3600);
    // A reload adds a group open by default.
    idle.observe("s", at(now), true, 30);
    expect(idle.since("s", at(now))).toBe(4600);
    advance(29.9);
    expect(closes).toEqual([]);
    advance(0.1);
    expect(closes).toEqual([{ sid: "s", idleS: 30, timeoutS: 30 }]);
  });

  test("a render that finishes after a newer one tells nothing", () => {
    const older = at(now);
    advance(1);
    // The newer frame, drawn after a ✕ click, shows no menu.
    idle.observe("s", at(now), false, 30);
    // The older frame, which drew the menu, finishes last.
    idle.observe("s", older, true, 30);
    expect(idle.getStats().armed).toBe(0);
    expect(idle.since("s", at(now))).toBeUndefined();
  });

  test("a click in another session moves nothing here", () => {
    idle.observe("s", at(now), true, 30);
    advance(20);
    idle.clicked("other", at(now));
    advance(10);
    expect(closes.map((c) => c.sid)).toEqual(["s"]);
  });

  test("a changed timeout is honoured", () => {
    idle.observe("s", at(now), true, 30);
    advance(10);
    idle.observe("s", at(now), true, 60);
    advance(20);
    expect(closes).toEqual([]);
    advance(30);
    expect(closes).toEqual([{ sid: "s", idleS: 60, timeoutS: 60 }]);
  });

  test("no menu drawn, no timer", () => {
    idle.observe("s", at(now), true, 30);
    advance(10);
    idle.observe("s", at(now), false, 30);
    expect(idle.getStats().armed).toBe(0);
    advance(60);
    expect(closes).toEqual([]);
  });

  test("a menu still drawn after a close closes a timeout later, never at once", () => {
    idle.observe("s", at(now), true, 30);
    advance(30);
    // The render after the close still draws a menu (a group open by default).
    idle.observe("s", at(now), true, 30);
    advance(29);
    expect(closes).toHaveLength(1);
    advance(1);
    expect(closes).toHaveLength(2);
  });

  test("a session that stops rendering after a close is closed once, not every timeout", () => {
    idle.observe("s", at(now), true, 30);
    advance(30);
    expect(closes).toHaveLength(1);
    expect(idle.getStats().armed).toBe(0);
    advance(300);
    expect(closes).toHaveLength(1);
  });

  test("a close that rejects is reported, and retried a timeout after the next render that draws the menu", async () => {
    const failing = new MenuIdle({
      now: () => at(now),
      close: async () => {
        throw new Error("no config");
      },
      failed: (sid, e) => failures.push(`${sid}: ${(e as Error).message}`),
    });
    failing.observe("s", at(now), true, 30);
    advance(30);
    await jest.advanceTimersByTimeAsync(0);
    expect(failures).toEqual(["s: no config"]);
    expect(failing.getStats().armed).toBe(0);
    advance(5);
    failing.observe("s", at(now), true, 30);
    advance(29.9);
    expect(failures).toHaveLength(1);
    advance(0.1);
    await jest.advanceTimersByTimeAsync(0);
    expect(failures).toHaveLength(2);
    failing.dispose();
  });
});

const ALLOWED = new Set(listResolvablePaletteNames());
const SID = "s1";
const TAB = "candybar.tab";
const PICKERS = "menus.candybar_pickers";
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
  const compiled = registerDslConfig(config, registry, {
    signer: TEST_SIGNER,
    cwd: "/tmp/proj",
  });
  const sink = new Map<string, readonly RichText[]>();
  // A frame drawn at `when`, its session idle since `idleSince`.
  const draw = (when: Instant, idleSince?: Instant) => {
    sink.clear();
    return drawPayload(
      config,
      compiled,
      store,
      registry,
      PAYLOAD,
      when,
      OPTS,
      { perSegmentSink: sink },
      selectionFor(config, idleSince === undefined ? {} : { idleSince }),
    );
  };
  sessionState.set(
    SID,
    SESSION_RENDER_ORIGIN_KEY,
    encodeRenderOrigin({
      projectDir: "/tmp/proj",
      cwd: "/tmp/proj",
      target: { source: "search" },
    }),
  );
  const logged: string[] = [];
  const ctx: VerbContext = {
    ...testVerbContext(sessionState),
    configFor: () => config,
    log: (_level, line) => logged.push(line),
  };
  const clickWriting = async (key: string, value: string): Promise<void> => {
    const url = linkUrls(draw(instantOf(new Date())).text).find((u) =>
      effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value),
    );
    if (!url) throw new Error(`no affordance writing ${key}=${value} rendered`);
    const { verb, value: v } = parseHandlerUrl(url);
    expect(clickSessionOf(verb, v)).toEqual({ ok: true, id: SID });
    await VERBS.get(verb)!(v, ctx);
  };
  const held = (key: string): string =>
    sessionState.get(SID, key) ?? disclosureNest(config).defaultOf(key);
  return { config, draw, clickWriting, held, logged, ctx };
}

const BUNDLED = `{ root: { h: ['directory', 'model'] } }`;
const IDLE = { idleS: 30, timeoutS: 30, stillIdle: () => true };

describe("the close is the write the door's ✕ makes, on a click's own path", () => {

  test("edit mode exits with the door, and its savepoint goes with it", async () => {
    const rt = buildRuntime(BUNDLED);
    await rt.clickWriting(SETTINGS_ANCHOR, SETTINGS_OPEN);
    await rt.clickWriting(EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    expect(rt.ctx.history.history(SID).savepoint).toBeDefined();
    await closeIdleMenus(SID, IDLE, rt.ctx);
    expect(rt.held(EDIT_MODE_KEY)).not.toBe(EDIT_MODE_ARRANGE);
    expect(rt.ctx.history.history(SID).savepoint).toBeUndefined();
  });

  test("a ✚ library open in edit mode with the door closed closes; edit mode, which drew no menu, stays", async () => {
    const rt = buildRuntime(`{
      segments: { arrange: { template: '{{ action "edit.toggle" "✎" }}' } },
      root: { h: ['directory', 'arrange'] },
    }`);
    const library = "menus.edit_default_insertSeg_0.edit_default_insert_0";
    await rt.clickWriting(EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    await rt.clickWriting(library, "edit.default.insert.0");
    expect(rt.held(SETTINGS_ANCHOR)).toBe(DISCLOSURE_CLOSED);
    expect(rt.draw(instantOf(new Date())).menuRows).toBeGreaterThan(0);
    await closeIdleMenus(SID, IDLE, rt.ctx);
    expect(rt.held(library)).toBe(DISCLOSURE_CLOSED);
    expect(rt.held(EDIT_MODE_KEY)).toBe(EDIT_MODE_ARRANGE);
    expect(rt.draw(instantOf(new Date())).menuRows).toBe(0);
    expect(rt.logged).toContain(
      `menu-idle: closed=${library} idle=30.0s timeout=30s (session=${SID})`,
    );
  });

  test("a toggle that hangs no menu is a view preference, and is left as it is", async () => {
    const rt = buildRuntime(BUNDLED);
    await rt.clickWriting(SETTINGS_ANCHOR, SETTINGS_OPEN);
    await rt.clickWriting(EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    await rt.clickWriting(EDIT_LIVE_KEY, "open");
    await closeIdleMenus(SID, IDLE, rt.ctx);
    expect(rt.held(SETTINGS_ANCHOR)).toBe(DISCLOSURE_CLOSED);
    expect(rt.held(EDIT_LIVE_KEY)).toBe("open");
  });

  test("a group open by default is closed, and stays closed", async () => {
    const rt = buildRuntime(`{ root: { v: [
      { kind: 'group', name: 'more', label: 'more', open: true, children: ['model'] },
      'directory',
    ] } }`);
    expect(rt.held("groups.more")).toBe("more");
    await closeIdleMenus(SID, IDLE, rt.ctx);
    expect(rt.held("groups.more")).toBe(DISCLOSURE_CLOSED);
    expect(rt.draw(instantOf(new Date())).menuRows).toBe(0);
  });

  test("with nothing open it writes nothing, and says so", async () => {
    const rt = buildRuntime(BUNDLED);
    await closeIdleMenus(SID, IDLE, rt.ctx);
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

  const rows = (text: string): string[] => text.split("\n");

  test("menu rows light while lit; bar rows never do", async () => {
    const rt = buildRuntime(BUNDLED);
    await rt.clickWriting(SETTINGS_ANCHOR, SETTINGS_OPEN);
    const calm = rt.draw(LIT);
    const lit = rt.draw(LIT, SINCE);
    expect(calm.menuRows).toBeGreaterThan(0);
    const bar = rows(calm.text).length - calm.menuRows;
    // The risen door's rows stack over the bar's: the bar is the last rows.
    expect(rows(lit.text).slice(-bar)).toEqual(rows(calm.text).slice(-bar));
    const menu = (text: string) => rows(text).slice(0, -bar);
    expect(menu(lit.text)).not.toEqual(menu(calm.text));
    // Light changes colour, never the words.
    expect(stripAnsi(lit.text)).toBe(stripAnsi(calm.text));
    expect(lit.motion).toBe("moves");
    // Lit, a menu row is one colour: every cell on the flash's fill.
    const grounds = (row: string): Set<string> =>
      new Set([...row.matchAll(/48;2;(\d+;\d+;\d+)m/g)].map((m) => m[1]!));
    for (const row of menu(lit.text)) expect(grounds(row).size).toBe(1);
    expect(grounds(menu(calm.text)[0]!).size).toBeGreaterThan(1);
  });

  test("dark between flashes, and before the flash begins, the bar is as it was", async () => {
    const rt = buildRuntime(BUNDLED);
    await rt.clickWriting(SETTINGS_ANCHOR, SETTINGS_OPEN);
    expect(rt.draw(DARK, SINCE).text).toBe(rt.draw(DARK).text);
    const waiting = rt.draw(BEFORE, SINCE);
    expect(waiting.text).toBe(rt.draw(BEFORE).text);
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
      const rt = buildRuntime(
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
    const rt = buildRuntime(BUNDLED);
    await rt.clickWriting(SETTINGS_ANCHOR, SETTINGS_OPEN);
    const opened = rt.draw(BEFORE);
    expect(opened.nextChange).toBe(Infinity);
    expect(opened.motion).toBe("can-move");
  });

  test("a bar with no menu open draws no menu rows, and never flashes", () => {
    const rt = buildRuntime(BUNDLED);
    const frame = rt.draw(LIT, SINCE);
    expect(frame.menuRows).toBe(0);
    expect(frame.text).toBe(rt.draw(LIT).text);
    expect(frame.motion).toBe("still");
  });
});
