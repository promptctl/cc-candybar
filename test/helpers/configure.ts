import {
  EDIT_CONFIGURE_KEY,
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../../src/config/loader/edit-mode";
import { configureMember } from "../../src/config/placement-keys";
import type { SessionStateRW } from "../../src/renderer-interface/session-state";
import type { SessionId } from "../../src/daemon/foundations/session-id";

// Configuring is a level inside arranging: edit mode on, and the configure key
// naming the one placement whose settings hang open.
// `store` is the session's view of the store, owned by the chain it renders
// (test/helpers/owned.ts).
export function configurePlacement(
  store: SessionStateRW,
  sessionId: SessionId,
  preset: string,
  id: string,
): void {
  store.set(sessionId, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
  store.set(sessionId, EDIT_CONFIGURE_KEY, configureMember(preset, id));
}
