// `◁` restores what the session's last navigating click opened or closed, and
// nothing else: the click path (the journaled verb table) records the step, a
// settings pick in the same click stays with undo, and going back is not
// itself a step.

import { SessionState } from "../src/renderer/session-state";
import { BadVerbArgs } from "../src/renderer/verbs";
import { stateGate } from "./helpers/gates";
import {
  encodeSegments,
  effectsUrl,
  VERB_COPY,
  VERB_SET_STATE,
  VERB_BACK,
  VERB_UNDO,
} from "../src/click/wire";
import {
  clickUrl,
  recordRender,
  testVerbContext,
  verbContextWith,
  CLICK_VERBS,
} from "./helpers/click";
import { EMPTY_DEFAULT } from "../scripts/lib/draw-fixtures/parse-and-validate";
import type { DslConfig } from "../src/config/dsl-types";
import { NavigationHistory } from "../src/renderer/navigation-history";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const S1 = sessionIdOf("s1");

const MENU = "nav-test.menu";
const TAB = "nav-test.tab";
const PAGE = "nav-test.page";
// A confirm's key, by the suffix every confirmStep gives it.
const ARMED = "nav-test.clear.armed";

// The config the session renders: its actions are what gate MENU, TAB and
// ARMED. `theme` is a built-in key, writable under any config.
const configWithTabs = (...tabs: string[]): DslConfig => ({
  ...EMPTY_DEFAULT,
  actions: {
    menu: { set: MENU, cycle: ["closed", "open"] },
    tab: { set: TAB, cycle: tabs },
    page: { set: PAGE, int: true },
    arm: { set: ARMED, cycle: ["armed", "disarmed"] },
  },
});

function setup() {
  const sessionState = new SessionState();
  let config = configWithTabs("a", "b");
  recordRender(sessionState, S1);
  const ctx = verbContextWith(testVerbContext(sessionState), {
    configFor: () => config,
  });
  const set = async (...pairs: string[]): Promise<void> =>
    await CLICK_VERBS.get(VERB_SET_STATE)!(
      encodeSegments(["s1", ...pairs]),
      ctx,
    );
  const back = async (): Promise<void> =>
    await CLICK_VERBS.get(VERB_BACK)!(encodeSegments(["s1"]), ctx);
  const undo = async (): Promise<void> =>
    await CLICK_VERBS.get(VERB_UNDO)!(encodeSegments(["s1"]), ctx);
  return {
    sessionState,
    ctx,
    // What the bar's ◁ counts: measured against the gate of the config the
    // session renders now.
    depth: (): number =>
      ctx.navigation.depth(S1, sessionState, {
        gate: ctx.gates.state.gateFor(config),
      }),
    // The session's config reloads as `next`.
    reload: (next: DslConfig): void => {
      config = next;
    },
    set,
    back,
    undo,
  };
}

describe("back", () => {
  test("a decision is never navigation: an armed confirm stays as it is", async () => {
    const { sessionState, depth, set, back } = setup();
    await set(ARMED, "armed");
    expect(depth()).toBe(0);
    // The door's click disarms beside closing the menu; going back reopens the
    // menu and leaves the confirm disarmed.
    await set(MENU, "open");
    await set(MENU, "closed", ARMED, "disarmed");
    await back();
    expect(sessionState.get(S1, MENU)).toBe("open");
    expect(sessionState.get(S1, ARMED)).toBe("disarmed");
  });

  test("a step buried under the newest is counted only if going back would still restore it", async () => {
    const { sessionState, depth, set, back } = setup();
    await set(MENU, "open");
    sessionState.clear(S1, MENU);
    await set(TAB, "b");
    expect(depth()).toBe(1);
    await back();
    expect(sessionState.get(S1, TAB)).toBeNull();
    expect(depth()).toBe(0);
  });

  test("Back preserves a control an independent transition has changed", async () => {
    const { sessionState, set, back } = setup();
    await set(MENU, "open");
    sessionState.set(S1, PAGE, "3");
    await back();
    expect(sessionState.get(S1, MENU)).toBeNull();
    expect(sessionState.get(S1, PAGE)).toBe("3");
  });

  test("a value the key's gate no longer admits is never restored", async () => {
    const { sessionState, depth, reload, set, back } = setup();
    await set(TAB, "a");
    await set(TAB, "b");
    // The config reloaded and `a` is gone from the key's domain.
    reload(configWithTabs("b"));
    // The newest step would write `a` back, so it is discarded — and the one
    // under it opened `a`, which the key no longer holds.
    expect(depth()).toBe(0);
    await expect(back).rejects.toThrow(BadVerbArgs);
    expect(sessionState.get(S1, TAB)).toBe("b");
  });

  test("a key one click writes twice goes back to its value before the click, unset included", () => {
    const store = new SessionState();
    const history = new NavigationHistory();
    const config = configWithTabs("a", "b");
    const context = { gate: stateGate(config) };
    const choose = store.setBatch.bind(store);
    const visit = history.begin(store, choose);
    visit.choose(S1, [{ key: MENU, value: "open" }], () => context);
    visit.choose(S1, [{ key: MENU, value: "closed" }], () => context);
    visit.commit();
    const back = history.begin(store, choose);
    back.back(S1, context);
    back.commit();
    expect(store.get(S1, MENU)).toBeNull();
  });

  test("a step over state something else has since rewritten is discarded, not replayed", async () => {
    const { sessionState, depth, set, back } = setup();
    await set(MENU, "open");
    await set(TAB, "b");
    // Not a navigating click: a layout edit releasing what the tab opened.
    sessionState.clear(S1, TAB);
    // ◁ counts only what a click on it restores.
    expect(depth()).toBe(1);
    await back();
    expect(sessionState.get(S1, MENU)).toBeNull();
    await expect(back()).rejects.toThrow(BadVerbArgs);
  });

  test("steps each navigating click back in turn, to the state before the first", async () => {
    const { sessionState, depth, set, back } = setup();
    await set(MENU, "open");
    await set(TAB, "b");
    expect(depth()).toBe(2);
    await back();
    expect(sessionState.get(S1, TAB)).toBeNull();
    expect(sessionState.get(S1, MENU)).toBe("open");
    await back();
    expect(sessionState.get(S1, MENU)).toBeNull();
    expect(depth()).toBe(0);
  });

  test("one click is one step, however many keys it moved", async () => {
    const { sessionState, depth, set, back } = setup();
    await set(MENU, "open", TAB, "a");
    expect(depth()).toBe(1);
    await back();
    expect(sessionState.get(S1, MENU)).toBeNull();
    expect(sessionState.get(S1, TAB)).toBeNull();
  });

  test("a setting picked in the same click stays picked, and undo still reaches it", async () => {
    const { sessionState, set, back, undo } = setup();
    await set(MENU, "open", "theme", "gruvbox");
    await back();
    expect(sessionState.get(S1, MENU)).toBeNull();
    expect(sessionState.get(S1, "theme")).toBe("gruvbox");
    await undo();
    expect(sessionState.get(S1, "theme")).toBeNull();
  });

  test("Back restores a page cursor without repeating the click's command", async () => {
    const { sessionState, ctx, set, back } = setup();
    await set(MENU, "open", TAB, "a", PAGE, "1");
    await clickUrl(
      effectsUrl([
        { verb: VERB_SET_STATE, args: [S1, PAGE, "2"] },
        { verb: VERB_COPY, args: ["an ordinary copy"] },
      ]),
      ctx,
    );
    expect(ctx.effects).toHaveLength(1);
    expect(sessionState.get(S1, PAGE)).toBe("2");
    await back();
    expect(ctx.effects).toHaveLength(1);
    expect(sessionState.get(S1, PAGE)).toBe("1");
    expect(sessionState.get(S1, MENU)).toBe("open");
    expect(sessionState.get(S1, TAB)).toBe("a");
  });

  test("a click that changes only a setting is no step", async () => {
    const { depth, set } = setup();
    await set("theme", "nord");
    expect(depth()).toBe(0);
  });

  test("going back is not itself a step, and an empty history refuses loudly", async () => {
    const { depth, set, back } = setup();
    await set(MENU, "open");
    await back();
    expect(depth()).toBe(0);
    await expect(back).rejects.toThrow(BadVerbArgs);
  });

  test("a click that writes what is already there is no step", async () => {
    const { depth, set } = setup();
    await set(MENU, "open");
    await set(MENU, "open");
    expect(depth()).toBe(1);
  });
});
