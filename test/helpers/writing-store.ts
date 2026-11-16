// An EditStore over the disk whose landing is performed there and then by the
// host's own interpreter (src/daemon/effect-interpreter.ts), so a test that
// writes through the config file store reads the file the write left. A
// refused change throws, naming what moved.

import { diffChanges } from "../../src/config/config-changes";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import { performChange } from "../../src/daemon/effect-interpreter";
import {
  readConfigText,
  type EditStore,
} from "../../src/renderer/config-file-store";
import type { EffectId } from "../../src/renderer-interface/interface";

export const writingStore: EditStore = {
  read: readConfigText,
  land: (file, before, after) => {
    const outcome = performChange({
      kind: "change",
      id: 0 as EffectId,
      session: "test" as SessionId,
      target: { kind: "layer", path: file },
      changes: diffChanges(before, after),
    });
    if (outcome.kind === "failed") throw new Error(outcome.reason);
  },
};
