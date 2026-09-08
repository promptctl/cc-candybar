// [LAW:single-enforcer] Pins the store's reactivity contract: a computed derived from SessionState.get() must re-evaluate after a set/clear.

import { computed, autorun } from "mobx";
import { SessionState } from "../src/daemon/session-state";

describe("SessionState MobX integration", () => {
  test("computed re-evaluates after set()", () => {
    const state = new SessionState();
    const cell = computed(() => state.get("s1", "theme") ?? "(unset)");

    const observed: string[] = [];
    const dispose = autorun(() => {
      observed.push(cell.get());
    });

    expect(observed).toEqual(["(unset)"]);

    state.set("s1", "theme", "ocean");
    expect(observed).toEqual(["(unset)", "ocean"]);

    state.set("s1", "theme", "ember");
    expect(observed).toEqual(["(unset)", "ocean", "ember"]);

    dispose();
  });

  test("computed re-evaluates after clear()", () => {
    const state = new SessionState();
    state.set("s1", "theme", "ocean");

    const cell = computed(() => state.get("s1", "theme") ?? "(unset)");
    const observed: string[] = [];
    const dispose = autorun(() => {
      observed.push(cell.get());
    });

    expect(observed).toEqual(["ocean"]);
    state.clear("s1", "theme");
    expect(observed).toEqual(["ocean", "(unset)"]);
    dispose();
  });

  test("cross-key mutations re-derive but do not propagate (MobX value memo)", () => {
    // [LAW:one-source-of-truth] One atom for the whole store; MobX's structural-equality
    // memo suppresses PROPAGATION to observers when the derived value is unchanged.
    const state = new SessionState();
    const cell = computed(() => state.get("s1", "theme") ?? "");

    const observed: string[] = [];
    const dispose = autorun(() => {
      observed.push(cell.get());
    });

    expect(observed).toEqual([""]);
    state.set("s1", "style", "surface");
    expect(observed).toEqual([""]);
    state.set("s1", "theme", "ocean");
    expect(observed).toEqual(["", "ocean"]);
    dispose();
  });

  test("get outside a reactive context still works and is silent", () => {
    const state = new SessionState();
    state.set("s1", "theme", "ocean");
    expect(state.get("s1", "theme")).toBe("ocean");
    expect(state.get("s1", "missing")).toBeNull();
  });
});
