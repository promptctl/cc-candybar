// [LAW:single-enforcer] SessionState is the canonical store and the MobX
// reactivity contract is now a property of the store itself (one atom, every
// read reportsObserved, every write reportsChanged). These tests pin that
// contract: a `computed` derived from SessionState.get() must re-evaluate
// after a set/clear, exactly the cascade the DSL `state` source binding
// relies on.

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
    // [LAW:one-source-of-truth] One atom for the whole store. Any mutation
    // marks every dependent computed stale and forces re-derivation; but
    // MobX's structural-equality memo on computed results suppresses
    // *propagation* to autoruns/observers when the derived value is unchanged.
    // This is the correct contract: session-state writes are rare, computeds
    // are cheap to re-evaluate, and the render layer reads value-not-signal.
    const state = new SessionState();
    const cell = computed(() => state.get("s1", "theme") ?? "");

    const observed: string[] = [];
    const dispose = autorun(() => {
      observed.push(cell.get());
    });

    expect(observed).toEqual([""]);
    state.set("s1", "style", "surface"); // unrelated key — value unchanged
    expect(observed).toEqual([""]); // autorun did not re-fire
    state.set("s1", "theme", "ocean"); // watched key — value changed
    expect(observed).toEqual(["", "ocean"]);
    dispose();
  });

  test("get outside a reactive context still works and is silent", () => {
    // Most callers read SessionState directly (segments renderer, install
    // path). reportObserved outside a tracking context is a no-op.
    const state = new SessionState();
    state.set("s1", "theme", "ocean");
    expect(state.get("s1", "theme")).toBe("ocean");
    expect(state.get("s1", "missing")).toBeNull();
  });
});
