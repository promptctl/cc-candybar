// [LAW:single-enforcer] What a stored session value is to the config a
// session renders with (Gate.verdict), and the judged reader every reader that
// interprets a value reads through (src/daemon/foundations/judged-state.ts).

import { computed } from "mobx";
import { judged } from "../../src/daemon/foundations/judged-state";
import { createGates } from "../../src/daemon/foundations/gates";
import { SessionState, SINGLE_RUN } from "../../src/daemon/session-state";
import { ENDCAPS_SHAPES, listResolvablePaletteNames } from "../../src/themes/policy";
import { stateGate } from "../helpers/gates";
import { parseAndValidate } from "../helpers/parse-and-validate";

const THEMES = new Set(listResolvablePaletteNames());

// A config whose controls write one key of each validator kind, a built-in
// key among them.
const controls = parseAndValidate(
  "<controls>",
  `{
    actions: {
      pick: { set: "mode", from: ["a", "b"] },
      page: { set: "page", int: true },
      wider: { set: "width", min: 1, max: 3, by: 1 },
      paint: { set: "theme", from: "themes" },
      expand: { set: "toolbar-expanded", to: "1" },
    },
  }`,
  THEMES,
);

const nothing = parseAndValidate("<nothing>", "{}", THEMES);

describe("a stored value's verdict", () => {
  const gate = stateGate(controls);

  test("a value a control can hold is held", () => {
    expect(gate.verdict("mode", "b")).toEqual({ kind: "held" });
    expect(gate.verdict("page", "-1")).toEqual({ kind: "held" });
    expect(gate.verdict("width", "3")).toEqual({ kind: "held" });
  });

  test("a value the gate refuses, or admits only by changing it, is foreign, with what the key admits", () => {
    expect(gate.verdict("mode", "c")).toEqual({
      kind: "foreign",
      admits: 'one of "a", "b"',
    });
    expect(gate.verdict("page", "x")).toEqual({
      kind: "foreign",
      admits: "an integer",
    });
    // Admitted as "7": a stored "007" was never written by this gate.
    expect(gate.verdict("page", "007").kind).toBe("foreign");
    // Clamped to 3: a value an older, wider range admitted.
    expect(gate.verdict("width", "9")).toEqual({
      kind: "foreign",
      admits: "an integer from 1 to 3",
    });
  });

  test("a built-in key the config's own action writes is its control's", () => {
    const verdict = gate.verdict("theme", "no-such-theme");
    expect(verdict.kind).toBe("foreign");
    if (verdict.kind === "foreign") expect(verdict.admits).toMatch(/"themes"/);
    // A stored "true" is a wire spelling no click stores, so it is foreign,
    // and the message names what a click does store.
    for (const held of ["maybe", "true"]) {
      expect(gate.verdict("toolbar-expanded", held)).toEqual({
        kind: "foreign",
        admits: '"1" for true or "" for false',
      });
    }
  });

  test("a key no `set` action of the config writes is the daemon's own, held whatever it holds", () => {
    for (const key of ["doctor.verdict", "update.dismissed"]) {
      expect(stateGate(nothing).verdict(key, "anything at all")).toEqual({
        kind: "held",
      });
    }
  });

  test("every validator accepts its own output unchanged, so whatever a click wrote reads back held", () => {
    const written: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["mode", ["a", "b"]],
      ["page", ["-1", "0", "007", "42"]],
      ["width", ["0", "1", "3", "9"]],
      ["theme", [...THEMES]],
      ["toolbar-expanded", ["1", "true", "0", "false", ""]],
    ];
    for (const [key, inputs] of written) {
      for (const input of inputs) {
        const result = gate.validate(key, input);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(gate.validate(key, result.value)).toEqual(result);
          expect(gate.verdict(key, result.value)).toEqual({ kind: "held" });
        }
      }
    }
    const endcaps = stateGate(
      parseAndValidate(
        "<endcaps>",
        `{ actions: { cap: { set: "endcaps", from: "endcaps" } } }`,
        THEMES,
      ),
    );
    for (const shape of ENDCAPS_SHAPES) {
      expect(endcaps.verdict("endcaps", shape)).toEqual({ kind: "held" });
    }
  });

  test("a daemon-wide registration is judged with its new members at the next read", () => {
    const gates = createGates({ state: [], config: [] });
    expect(gates.state.gateFor(controls).verdict("mode", "z").kind).toBe(
      "foreign",
    );
    const dispose = gates.state.register("mode", ["z"]);
    expect(gates.state.gateFor(controls).verdict("mode", "z")).toEqual({
      kind: "held",
    });
    dispose();
    expect(gates.state.gateFor(controls).verdict("mode", "z").kind).toBe(
      "foreign",
    );
  });

  test("a kept computed over a verdict re-judges when a daemon-wide registration comes and goes", () => {
    const gates = createGates({ state: [], config: [] });
    const verdict = computed(
      () => gates.state.gateFor(controls).verdict("mode", "z").kind,
      { keepAlive: true },
    );
    expect(verdict.get()).toBe("foreign");
    const dispose = gates.state.register("mode", ["z"]);
    expect(verdict.get()).toBe("held");
    dispose();
    expect(verdict.get()).toBe("foreign");
  });
});

describe("a judged read", () => {
  test("reads a foreign value as absent, a held one as itself, and an absent one as absent", () => {
    const state = new SessionState(SINGLE_RUN);
    state.set("s", "mode", "c");
    state.set("s", "width", "2");
    state.set("s", "doctor.verdict", "free text");
    const reads = judged(state, () => stateGate(controls));
    expect(reads.get("s", "mode")).toBeNull();
    expect(reads.get("s", "width")).toBe("2");
    expect(reads.get("s", "doctor.verdict")).toBe("free text");
    expect(reads.get("s", "page")).toBeNull();
    expect(reads.revision("s")).toBe(state.revision("s"));
  });
});
