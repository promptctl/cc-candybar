// An in-memory list of the terminals a doctor click came back from, for tests
// that hand the doctor a fake edge: the production one is a file under the
// daemon's state directory.
import type { ClickedTerminalsStore } from "../../src/doctor/clicked-terminals";

export function memoryClickedTerminals(initial: readonly string[] = []): ClickedTerminalsStore & {
  readonly list: () => readonly string[];
} {
  let list = initial;
  return {
    read: () => ({ kind: "ok", value: list }),
    record: (sighting) => {
      if (!list.includes(sighting)) list = [...list, sighting];
    },
    list: () => list,
  };
}
