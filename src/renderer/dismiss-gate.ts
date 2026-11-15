// The update notice's dismiss allow-list, which follows the update every
// session's world state carries: a dismissal names the newer thing's
// identity, so it lapses the moment something newer again appears.

import { compareStructural, reaction } from "mobx";
import type { Gates } from "../daemon/foundations/gates.js";
import { UPDATE_DISMISSED_KEY } from "../daemon/foundations/update-keys.js";
import { updateIdentity } from "../daemon/foundations/update-offer.js";
import type { WorldStates } from "./world-states.js";

// [LAW:single-enforcer] The one writer of the dismiss key's allow-list: the
// renderer that holds the gates, from the newest world state handed in.
// Returns what stops it.
export function followDismissGate(
  gates: Gates,
  worldStates: Pick<WorldStates, "newestUpdate">,
): () => void {
  let dispose: (() => void) | null = null;
  const stop = reaction(
    () => {
      const newer = worldStates.newestUpdate();
      return newer?.kind === "ok" ? updateIdentity(newer.value) : null;
    },
    (identity) => {
      dispose?.();
      dispose =
        identity === null
          ? null
          : gates.state.register(UPDATE_DISMISSED_KEY, [identity]);
    },
    { equals: compareStructural, fireImmediately: true },
  );
  return () => {
    stop();
    dispose?.();
  };
}
