// `◁` restores what the session's last navigating click opened or closed, and
// nothing else: the click path (the journaled verb table) records the step, a
// settings pick in the same click stays with undo, and going back is not
// itself a step.

import { SessionState } from "../src/daemon/session-state";
import { VERBS, BadVerbArgs } from "../src/daemon/verbs";
import { registerStateValidator } from "../src/daemon/verbs/state-validators";
import {
  encodeSegments,
  VERB_SET_STATE,
  VERB_BACK,
  VERB_UNDO,
} from "../src/click/wire";
import { testVerbContext } from "./helpers/click";
import { UPDATE_DISMISSED_KEY } from "../src/daemon/update-notice";
import { NavigationHistory } from "../src/daemon/navigation-history";

const MENU = "nav-test.menu";
const TAB = "nav-test.tab";
// A confirm's key, by the suffix every confirmStep gives it.
const ARMED = "nav-test.clear.armed";

function setup() {
  const sessionState = new SessionState();
  const ctx = testVerbContext(sessionState);
  const disposers = [
    registerStateValidator(MENU, {
      kind: "allow-list",
      allowed: ["closed", "open"],
    }),
    registerStateValidator(TAB, {
      kind: "allow-list",
      allowed: ["a", "b"],
    }),
    registerStateValidator(ARMED, {
      kind: "allow-list",
      allowed: ["armed", "disarmed"],
    }),
    registerStateValidator(UPDATE_DISMISSED_KEY, {
      kind: "allow-list",
      allowed: ["1.2.3"],
    }),
  ];
  // `theme` is a built-in key: its gate (the installed themes) is permanent.
  const set = (...pairs: string[]): void =>
    VERBS.get(VERB_SET_STATE)!(encodeSegments(["s1", ...pairs]), ctx);
  const back = (): void => VERBS.get(VERB_BACK)!(encodeSegments(["s1"]), ctx);
  const undo = (): void => VERBS.get(VERB_UNDO)!(encodeSegments(["s1"]), ctx);
  return {
    sessionState,
    ctx,
    set,
    back,
    undo,
    dispose: () => disposers.forEach((d) => d()),
  };
}

describe("back", () => {
  test("a decision is never navigation: an armed confirm and a dismissed notice stay as they are", () => {
    const { sessionState, ctx, set, back, dispose } = setup();
    set(ARMED, "armed");
    set(UPDATE_DISMISSED_KEY, "1.2.3");
    expect(ctx.navigation.depth("s1", sessionState)).toBe(0);
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

  test("a key one click writes twice goes back to its value before the click, unset included", () => {
    const store = new SessionState();
    const history = new NavigationHistory();
    const journal = history.begin(store);
    journal.sessionState.set("s1", MENU, "open");
    journal.sessionState.set("s1", MENU, "closed");
    journal.commit();
    history.back("s1", store);
    expect(store.get("s1", MENU)).toBeNull();
  });

  test("a step over state something else has since rewritten is discarded, not replayed", () => {
    const { sessionState, ctx, set, back, dispose } = setup();
    set(MENU, "open");
    set(TAB, "b");
    // Not a navigating click: a layout edit releasing what the tab opened.
    sessionState.clear("s1", TAB);
    // ◁ counts only what a click on it restores.
    expect(ctx.navigation.depth("s1", sessionState)).toBe(1);
    back();
    expect(sessionState.get("s1", MENU)).toBeNull();
    expect(() => back()).toThrow(BadVerbArgs);
    dispose();
  });

  test("steps each navigating click back in turn, to the state before the first", () => {
    const { sessionState, ctx, set, back, dispose } = setup();
    set(MENU, "open");
    set(TAB, "b");
    expect(ctx.navigation.depth("s1", sessionState)).toBe(2);
    back();
    expect(sessionState.get("s1", TAB)).toBeNull();
    expect(sessionState.get("s1", MENU)).toBe("open");
    back();
    expect(sessionState.get("s1", MENU)).toBeNull();
    expect(ctx.navigation.depth("s1", sessionState)).toBe(0);
    dispose();
  });

  test("one click is one step, however many keys it moved", () => {
    const { sessionState, ctx, set, back, dispose } = setup();
    set(MENU, "open", TAB, "a");
    expect(ctx.navigation.depth("s1", sessionState)).toBe(1);
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
    const { sessionState, ctx, set, dispose } = setup();
    set("theme", "nord");
    expect(ctx.navigation.depth("s1", sessionState)).toBe(0);
    dispose();
  });

  test("going back is not itself a step, and an empty history refuses loudly", () => {
    const { sessionState, ctx, set, back, dispose } = setup();
    set(MENU, "open");
    back();
    expect(ctx.navigation.depth("s1", sessionState)).toBe(0);
    expect(back).toThrow(BadVerbArgs);
    dispose();
  });

  test("a click that writes what is already there is no step", () => {
    const { sessionState, ctx, set, dispose } = setup();
    set(MENU, "open");
    set(MENU, "open");
    expect(ctx.navigation.depth("s1", sessionState)).toBe(1);
    dispose();
  });
});
