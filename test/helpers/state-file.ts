// An in-memory state file for tests that hand the doctor a fake edge: the
// production ones are files under the daemon's state directory
// (src/doctor/state-file.ts).
import type { StateFile } from "../../src/doctor/state-file";

export function memoryStateFile<T>(initial: T): StateFile<T> & {
  readonly value: () => T;
} {
  let value = initial;
  return {
    read: () => ({ kind: "ok", value }),
    update: (next) => (value = next(value)),
    value: () => value,
  };
}
