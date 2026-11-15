// The update notice's dismiss allow-list follows the update the newest world
// state carries, so a dismissal names only what is newer now.

import { observable, runInAction } from "mobx";
import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import {
  daemonGates,
  UPDATE_DISMISSED_KEY,
} from "../../src/daemon/foundations/update-keys";
import type { Fact } from "../../src/facts/fact";
import type { Update } from "../../src/facts/world-state";
import { followDismissGate } from "../../src/renderer/dismiss-gate";
import type { Instant } from "../../src/utils/instant";

const release = (major: number): Fact<Update> => ({
  kind: "ok",
  value: { kind: "release", newer: [major, 0, 0], running: [1, 0, 0] },
  at: 0 as Instant,
});

test("a dismissal is admitted for what is newer now, and for nothing once nothing is", () => {
  const gates = daemonGates();
  const newest = observable.box<Fact<Update> | null>(null, { deep: false });
  const stop = followDismissGate(gates, { newestUpdate: () => newest.get() });
  const admits = (identity: string): boolean =>
    gates.state
      .gateFor(DEFAULT_DSL_CONFIG)
      .validate(UPDATE_DISMISSED_KEY, identity).ok;

  expect(admits("2.0.0")).toBe(false);
  runInAction(() => newest.set(release(2)));
  expect(admits("2.0.0")).toBe(true);
  runInAction(() => newest.set(release(3)));
  expect([admits("2.0.0"), admits("3.0.0")]).toEqual([false, true]);
  stop();
  expect(admits("3.0.0")).toBe(false);
});
