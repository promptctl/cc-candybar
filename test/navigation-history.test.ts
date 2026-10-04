// `◁` restores what the session's last navigating click opened or closed, and
// nothing else: the click path (the journaled verb table) records the step, a
// settings pick in the same click stays with undo, and going back is not
// itself a step.

import { SessionState } from "../src/daemon/session-state";
import { VERBS, BadVerbArgs } from "../src/daemon/verbs";
import {
  registerStateValidator,
  stateGate,
} from "../src/daemon/verbs/state-validators";
import {
  encodeSegments,
  VERB_SET_STATE,
  VERB_BACK,
  VERB_UNDO,
} from "../src/click/wire";
import { recordRender, testVerbContext } from "./helpers/click";
import { EMPTY_DEFAULT } from "./helpers/parse-and-validate";
import type { DslConfig } from "../src/config/dsl-types";
import { UPDATE_DISMISSED_KEY } from "../src/daemon/update-notice";
import { NavigationHistory } from "../src/daemon/navigation-history";

const MENU = "nav-test.menu";
const TAB = "nav-test.tab";
// A confirm's key, by the suffix every confirmStep gives it.
const ARMED = "nav-test.clear.armed";

// The config the session renders: its actions are what gate MENU, TAB and
// ARMED. `theme` is a built-in key, writable under any config.
const configWithTabs = (...tabs: string[]): DslConfig => ({
  ...EMPTY_DEFAULT,
  actions: {
    menu: { set: MENU, cycle: ["closed", "open"] },
    tab: { set: TAB, cycle: tabs },
    arm: { set: ARMED, cycle: ["armed", "disarmed"] },
  },
});

function setup() {
  const sessionState = new SessionState();
  let config = configWithTabs("a", "b");
  recordRender(sessionState, "s1");
  const ctx = {
    ...testVerbContext(sessionState),
    configFor: () => config,
  };
  // The update notice's dismissal is the daemon's own key, not a config's.
  const dispose = registerStateValidator(UPDATE_DISMISSED_KEY, ["1.2.3"]);
  const set = (...pairs: string[]): void =>
    VERBS.get(VERB_SET_STATE)!(encodeSegments(["s1", ...pairs]), ctx);
  const back = (): void => VERBS.get(VERB_BACK)!(encodeSegments(["s1"]), ctx);
  const undo = (): void => VERBS.get(VERB_UNDO)!(encodeSegments(["s1"]), ctx);
  return {
    sessionState,
    // What the bar's ◁ counts: measured against the gate of the config the
    // session renders now.
    depth: (): number =>
      ctx.navigation.depth("s1", sessionState, stateGate(config)),
    // The session's config reloads as `next`.
    reload: (next: DslConfig): void => {
      config = next;
    },
    set,
    back,
    undo,
    dispose,
  };
}

describe("back", () => {
  test("a decision is never navigation: an armed confirm and a dismissed notice stay as they are", () => {
    const { sessionState, depth, set, back, dispose } = setup();
    set(ARMED, "armed");
    set(UPDATE_DISMISSED_KEY, "1.2.3");
    expect(depth()).toBe(0);
    // The door's click disarms beside closing the menu; going back reopens the
    // menu and leaves the confirm disarmed.
    set(MENU, "open");
    set(MENU, "closed", ARMED, "disarmed");
    back();
    expect(sessionState.get("s1", MENU)).toBe("open");
    expect(sessionState.get("s1", ARMED)).toBe("disarmed");
    expect(sessionState.get("s1", UPDATE_DISMISSED_KEY)).toBe("1.2.3");
    dispose();
  });

  test("a step buried under the newest is counted only if going back would still restore it", () => {
    const { sessionState, depth, set, back, dispose } = setup();
    set(MENU, "open");
    sessionState.clear("s1", MENU);
    set(TAB, "b");
    expect(depth()).toBe(1);
    back();
    expect(sessionState.get("s1", TAB)).toBeNull();
    expect(depth()).toBe(0);
    dispose();
  });

  test("a value the key's gate no longer admits is never restored", () => {
    const { sessionState, depth, reload, set, back, dispose } = setup();
    set(TAB, "a");
    set(TAB, "b");
    // The config reloaded and `a` is gone from the key's domain.
    reload(configWithTabs("b"));
    // The newest step would write `a` back, so it is discarded — and the one
    // under it opened `a`, which the key no longer holds.
    expect(depth()).toBe(0);
    expect(back).toThrow(BadVerbArgs);
    expect(sessionState.get("s1", TAB)).toBe("b");
    dispose();
  });

  test("a key one click writes twice goes back to its value before the click, unset included", () => {
    const store = new SessionState();
    const history = new NavigationHistory();
    const journal = history.begin(store);
    journal.sessionState.set("s1", MENU, "open");
    journal.sessionState.set("s1", MENU, "closed");
    journal.commit();
    history.back("s1", store, stateGate(EMPTY_DEFAULT));
    expect(store.get("s1", MENU)).toBeNull();
  });

  test("a step over state something else has since rewritten is discarded, not replayed", () => {
    const { sessionState, depth, set, back, dispose } = setup();
    set(MENU, "open");
    set(TAB, "b");
    // Not a navigating click: a layout edit releasing what the tab opened.
    sessionState.clear("s1", TAB);
    // ◁ counts only what a click on it restores.
    expect(depth()).toBe(1);
    back();
    expect(sessionState.get("s1", MENU)).toBeNull();
    expect(() => back()).toThrow(BadVerbArgs);
    dispose();
  });

  test("steps each navigating click back in turn, to the state before the first", () => {
    const { sessionState, depth, set, back, dispose } = setup();
    set(MENU, "open");
    set(TAB, "b");
    expect(depth()).toBe(2);
    back();
    expect(sessionState.get("s1", TAB)).toBeNull();
    expect(sessionState.get("s1", MENU)).toBe("open");
    back();
    expect(sessionState.get("s1", MENU)).toBeNull();
    expect(depth()).toBe(0);
    dispose();
  });

  test("one click is one step, however many keys it moved", () => {
    const { sessionState, depth, set, back, dispose } = setup();
    set(MENU, "open", TAB, "a");
    expect(depth()).toBe(1);
    back();
    expect(sessionState.get("s1", MENU)).toBeNull();
    expect(sessionState.get("s1", TAB)).toBeNull();
    dispose();
  });

  test("a setting picked in the same click stays picked, and undo still reaches it", () => {
    const { sessionState, set, back, undo, dispose } = setup();
    set(MENU, "open", "theme", "gruvbox");
    back();
    expect(sessionState.get("s1", MENU)).toBeNull();
    expect(sessionState.get("s1", "theme")).toBe("gruvbox");
    undo();
    expect(sessionState.get("s1", "theme")).toBeNull();
    dispose();
  });

  test("a click that changes only a setting is no step", () => {
    const { depth, set, dispose } = setup();
    set("theme", "nord");
    expect(depth()).toBe(0);
    dispose();
  });

  test("going back is not itself a step, and an empty history refuses loudly", () => {
    const { depth, set, back, dispose } = setup();
    set(MENU, "open");
    back();
    expect(depth()).toBe(0);
    expect(back).toThrow(BadVerbArgs);
    dispose();
  });

  test("a click that writes what is already there is no step", () => {
    const { depth, set, dispose } = setup();
    set(MENU, "open");
    set(MENU, "open");
    expect(depth()).toBe(1);
    dispose();
  });
});
