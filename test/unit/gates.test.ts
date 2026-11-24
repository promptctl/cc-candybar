// [LAW:no-shared-mutable-globals] What a load accepts is the gates it is given:
// two values share nothing, and held keys apply from construction.

import { createGates } from "../../src/daemon/foundations/gates";
import { EMPTY_DEFAULT } from "../../scripts/lib/draw-fixtures/parse-and-validate";

const NONE = { state: [], config: [] };

describe("a gates value is the whole of what its loads accept", () => {
  test("a key registered on one value is unknown to another, in both keyspaces", () => {
    const a = createGates(NONE);
    const b = createGates(NONE);
    a.state.register("mode", ["full"]);
    a.config.register("height", ["3"]);
    expect(a.state.gateFor(EMPTY_DEFAULT).listKeys()).toContain("mode");
    expect(a.config.gateFor(EMPTY_DEFAULT).listKeys()).toContain("height");
    expect(b.state.gateFor(EMPTY_DEFAULT).listKeys()).not.toContain("mode");
    expect(b.config.gateFor(EMPTY_DEFAULT).listKeys()).not.toContain("height");
  });

  test("a value built with held keys writes them from the first gate", () => {
    const gates = createGates({
      state: [{ key: "mode", allowed: ["full"] }],
      config: [],
    });
    expect(gates.state.gateFor(EMPTY_DEFAULT).validate("mode", "full")).toEqual(
      {
        ok: true,
        value: "full",
      },
    );
  });

  test("a held key stays when a later registration of it is disposed", () => {
    const key = "daemon.example";
    const gates = createGates({ state: [{ key, allowed: [] }], config: [] });
    const dispose = gates.state.register(key, ["abc"]);
    expect(
      gates.state.gateFor(EMPTY_DEFAULT).validate(key, "abc"),
    ).toEqual({ ok: true, value: "abc" });
    dispose();
    expect(gates.state.gateFor(EMPTY_DEFAULT).listKeys()).toContain(
      key,
    );
  });
});
