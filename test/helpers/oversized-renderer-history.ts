import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import {
  EMPTY_STORED_STATE,
  type StoredState,
} from "../../src/renderer-interface/stored-state";

export const oversizedSession = sessionIdOf("oversized-history");

// One unsplittable step exceeds the history's 8 MiB bound.
export function oversizedRendererHistory(): StoredState {
  return {
    ...EMPTY_STORED_STATE,
    history: {
      [oversizedSession]: {
        past: [
          [
            {
              kind: "session",
              key: "menu",
              before: null,
              after: "x".repeat(9 * 1024 * 1024),
            },
          ],
        ],
        future: [],
      },
    },
  };
}
