// [LAW:one-source-of-truth] A dismiss link may write only the identity of the
// update the newest fact names. Documents of different sessions arrive in no
// order between them, so the gate follows the newest answered fact by its
// stamp, and a late document carrying an older fact does not move it back.

import {
  daemonGates,
  UPDATE_DISMISSED_KEY,
} from "../../src/daemon/foundations/update-keys";
import { UpdateGate } from "../../src/renderer/update-gate";
import type { Fact } from "../../src/facts/fact";
import type { Update } from "../../src/facts/world-state";
import type { Instant } from "../../src/utils/instant";
import { pendingOf } from "../../src/utils/outcome";
import { EMPTY_DEFAULT } from "../helpers/parse-and-validate";

const release = (patch: number, at: number): Fact<Update> => ({
  kind: "ok",
  value: { kind: "release", newer: [9, 0, patch], running: [1, 0, 0] },
  at: at as Instant,
});

function gated() {
  const gates = daemonGates();
  const gate = new UpdateGate(gates);
  const admits = (identity: string): boolean =>
    gates.state.gateFor(EMPTY_DEFAULT).validate(UPDATE_DISMISSED_KEY, identity)
      .ok;
  return { gate, admits };
}

describe("the update gate follows the newest fact", () => {
  test("an answered fact admits its identity, and a newer one replaces it", () => {
    const { gate, admits } = gated();
    expect(admits("9.0.1")).toBe(false);
    gate.took(release(1, 10));
    expect(admits("9.0.1")).toBe(true);
    gate.took(release(2, 20));
    expect(admits("9.0.2")).toBe(true);
    expect(admits("9.0.1")).toBe(false);
  });

  test("a document carrying an older fact does not move the gate back", () => {
    const { gate, admits } = gated();
    gate.took(release(2, 20));
    gate.took(release(1, 10));
    expect(admits("9.0.2")).toBe(true);
    expect(admits("9.0.1")).toBe(false);
  });

  test("a fact read at the same instant moves it, as on a held clock", () => {
    const { gate, admits } = gated();
    gate.took(release(1, 10));
    gate.took(release(2, 10));
    expect(admits("9.0.2")).toBe(true);
    expect(admits("9.0.1")).toBe(false);
  });

  test("a newer fact naming no update closes the gate; a pending one moves nothing", () => {
    const { gate, admits } = gated();
    gate.took(release(1, 10));
    gate.took(pendingOf("unread"));
    expect(admits("9.0.1")).toBe(true);
    gate.took({ kind: "absent", at: 30 as Instant });
    expect(admits("9.0.1")).toBe(false);
  });
});
