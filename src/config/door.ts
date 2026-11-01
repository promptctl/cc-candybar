// The settings menu's door: its anchor and the disclosure it opens. Downhill
// of the settings menu (src/config/settings-menu.ts) and of edit mode, which
// lives inside the door (src/config/loader/edit-mode.ts), so both name one
// door [LAW:one-way-deps].

import { DISCLOSURE_OPEN } from "./disclosure.js";
import type { DisclosureRef } from "./dsl-types.js";
import { SETTINGS_NS } from "./loader/reserved-namespace.js";

// [LAW:one-source-of-truth] THE anchor: one string that is simultaneously the
// segment name an author places in `root` to choose the menu's position, the
// name of the toggle segment the synthesis puts there, the disclosure's state
// variable, and its cycle action. Group sugar already spans those four with one
// `groups.<name>` string for the same reason — one name means the toggle's
// click and the body's `when` cannot address different keys.
export const SETTINGS_ANCHOR = `${SETTINGS_NS}menu`;

// The open member of every binary disclosure this menu mints — each holds the
// CLOSED sentinel or this. The tab key is the accordion exception: it holds
// the open tab's name.
export const SETTINGS_OPEN = DISCLOSURE_OPEN;

// [LAW:one-source-of-truth] The door's disclosure as a ref rather than a gate
// string (each tab's is `tabRef`): every gate the menu builds — and every
// `(?)` nested inside them — derives from a ref, so the toggle that writes a
// key and the `when` that reads it cannot name different variables.
export const SETTINGS_REF: DisclosureRef = {
  variable: SETTINGS_ANCHOR,
  key: SETTINGS_ANCHOR,
  member: SETTINGS_OPEN,
};

// [LAW:one-source-of-truth] The session key the diagnostics viewer is open
// under, written by the indicator the door carries (its `set`-int action, so
// every config's gate holds it) and by the viewer's own ‹ › ✕: the key of the
// message and page it shows (viewerKey), closed at any value no message in the
// draw's list has — ✕'s, or the key absent (src/render/diagnostics.ts).
export const DIAGNOSTICS_VIEWING = `${SETTINGS_NS}diagnostics`;
