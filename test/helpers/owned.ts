// The owner a test's click path and its rig draw under, and the session
// store as that owner reads and writes it (src/renderer/owned-store.ts): the
// raw store refuses a placement's key in owner-free form, as the daemon's
// does, so a test seeds and reads those keys through this view.

import { fileOwner, type Owner } from "../../src/config/placement-keys";
import { ownedStore } from "../../src/renderer/owned-store";
import type { SessionStateRW } from "../../src/renderer-interface/session-state";

export const TEST_OWNER: Owner = fileOwner("<test>");

export const ownedView = (
  store: SessionStateRW,
  owner: Owner = TEST_OWNER,
): SessionStateRW => ownedStore(store, () => owner);
