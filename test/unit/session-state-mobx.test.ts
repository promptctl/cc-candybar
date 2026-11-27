import { computed, autorun } from "mobx";
import { SessionState } from "../../src/renderer/session-state";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";

const S1 = sessionIdOf("s1");

describe("SessionState MobX integration", () => {
  test("computed re-evaluates after set()", () => {
    const state = new SessionState();
    const cell = computed(() => state.get(S1, "theme") ?? "(unset)");

    const observed: string[] = [];
    const dispose = autorun(() => {
      observed.push(cell.get());
    });

    expect(observed).toEqual(["(unset)"]);

    state.set(S1, "theme", "ocean");
    expect(observed).toEqual(["(unset)", "ocean"]);

    state.set(S1, "theme", "ember");
    expect(observed).toEqual(["(unset)", "ocean", "ember"]);

    dispose();
  });

  test("computed re-evaluates after clear()", () => {
    const state = new SessionState();
    state.set(S1, "theme", "ocean");

    const cell = computed(() => state.get(S1, "theme") ?? "(unset)");
    const observed: string[] = [];
    const dispose = autorun(() => {
      observed.push(cell.get());
    });

    expect(observed).toEqual(["ocean"]);
    state.clear(S1, "theme");
    expect(observed).toEqual(["ocean", "(unset)"]);
    dispose();
  });

  test("only a changed pick or session revision reevaluates its reader", () => {
    const state = new SessionState();
    const other = sessionIdOf("other");
    const counts = { theme: 0, style: 0, revision: 0, other: 0 };
    const read = (
      field: keyof typeof counts,
      value: () => string | number | null,
    ) => {
      const pick = computed(() => {
        counts[field]++;
        return value();
      });
      return autorun(() => {
        pick.get();
      });
    };
    const release = [
      read("theme", () => state.get(S1, "theme")),
      read("style", () => state.get(S1, "style")),
      read("revision", () => state.revision(S1)),
      read("other", () => state.get(other, "theme")),
    ];
    try {
      state.set(S1, "theme", "ocean");
      expect(counts).toEqual({ theme: 2, style: 1, revision: 2, other: 1 });
      state.set(other, "theme", "ocean");
      state.heard(S1);
      state.set(S1, "theme", "ocean");
      expect(counts).toEqual({ theme: 2, style: 1, revision: 2, other: 2 });
      state.clear(S1, "theme");
      expect(counts).toEqual({ theme: 3, style: 1, revision: 3, other: 2 });
    } finally {
      release.forEach((stop) => stop());
    }
    expect(state.observers()).toBe(0);
  });

  test("one reader observes a complete batch and then the eviction", () => {
    const state = new SessionState({}, 1);
    const seen: Array<Array<string | null>> = [];
    const stop = autorun(() =>
      seen.push([state.get(S1, "a"), state.get(S1, "b")]),
    );
    try {
      expect(state.observers()).toBe(1);
      state.setBatch(S1, [
        { key: "a", value: "one" },
        { key: "b", value: "two" },
      ]);
      state.set(sessionIdOf("next"), "x", "three");
      expect(seen).toEqual([
        [null, null],
        ["one", "two"],
        [null, null],
      ]);
      expect(state.revision(S1)).toBe(0);
    } finally {
      stop();
    }
  });

  test("get outside a reactive context still works and is silent", () => {
    // Most callers read SessionState directly (segments renderer, install
    // path). reportObserved outside a tracking context is a no-op.
    const state = new SessionState();
    state.set(S1, "theme", "ocean");
    expect(state.get(S1, "theme")).toBe("ocean");
    expect(state.get(S1, "missing")).toBeNull();
  });
});
