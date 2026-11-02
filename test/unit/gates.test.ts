// [LAW:no-shared-mutable-globals] What a load accepts is the gates it is given:
// two values share nothing, and a daemon's gates hold the update notice's keys
// from construction.

import { UPDATE_DISMISSED_KEY, UPDATE_NOTICE_FIELD, UPDATE_NOTICE_SESSION_KEY, daemonGates } from "../../src/daemon/update-keys";
import { createGates } from "../../src/daemon/foundations/gates";
import { EMPTY_DEFAULT } from "../helpers/parse-and-validate";

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
    expect(gates.state.gateFor(EMPTY_DEFAULT).validate("mode", "full")).toEqual({
      ok: true,
      value: "full",
    });
  });

  test("a daemon's gates hold the update notice's keys, and a bare value does not", () => {
    const held = daemonGates();
    expect(held.state.gateFor(EMPTY_DEFAULT).listKeys()).toEqual(
      expect.arrayContaining([UPDATE_NOTICE_SESSION_KEY, UPDATE_DISMISSED_KEY]),
    );
    expect(held.config.gateFor(EMPTY_DEFAULT).listKeys()).toContain(
      UPDATE_NOTICE_FIELD,
    );
    expect(createGates(NONE).state.gateFor(EMPTY_DEFAULT).listKeys()).not.toContain(
      UPDATE_DISMISSED_KEY,
    );
  });

  test("a held key stays when a later registration of it is disposed", () => {
    const gates = daemonGates();
    const dispose = gates.state.register(UPDATE_DISMISSED_KEY, ["abc"]);
    expect(
      gates.state.gateFor(EMPTY_DEFAULT).validate(UPDATE_DISMISSED_KEY, "abc"),
    ).toEqual({ ok: true, value: "abc" });
    dispose();
    expect(gates.state.gateFor(EMPTY_DEFAULT).listKeys()).toContain(
      UPDATE_DISMISSED_KEY,
    );
  });
});
