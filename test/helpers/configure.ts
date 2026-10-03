import {
  configureMember,
  EDIT_CONFIGURE_KEY,
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../../src/config/loader/edit-mode";

// Configuring is a level inside arranging: edit mode on, and the configure key
// naming the one placement whose settings hang open.
export function configurePlacement(
  store: { set(sessionId: string, key: string, value: string): void },
  sessionId: string,
  preset: string,
  id: string,
): void {
  store.set(sessionId, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
  store.set(sessionId, EDIT_CONFIGURE_KEY, configureMember(preset, id));
}
