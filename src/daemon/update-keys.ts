// The keys the update notice's links write, and the gates a daemon holds them
// in. Apart from update-notice.ts so that a process that builds a daemon's
// gates (`check`, the demo) loads neither the notice nor the version stamp.

import type { Globals } from "../config/dsl-types";
import { SETTINGS } from "../config/setting-projections";
import { createGates, type Gates } from "./foundations/gates";

// [LAW:one-source-of-truth] The session key a dismissal writes and the
// config field a disable writes, spelled once. The field is checked against
// Globals so a rename there fails here at compile time.
export const UPDATE_DISMISSED_KEY = "update.dismissed";
export const UPDATE_NOTICE_FIELD = "updateNotice" satisfies keyof Globals;
// The session half of the same setting (the settings menu's toggle). A disable
// writes both layers: the file so every session starts disabled, and this
// session's pick, which outranks the file and may hold `true` from the toggle.
export const UPDATE_NOTICE_SESSION_KEY = SETTINGS.updateNotice.sessionKey;

// [LAW:one-source-of-truth] The keys the notice's links write, held from the
// gates' construction so every config's gate is built against them: [disable]'s
// two, and [dismiss]'s with no member until something newer exists (syncGate
// adds the identity).
// [LAW:single-enforcer] The one place a daemon's gates are said to hold them:
// the daemon and `cc-candybar check` both build theirs here, so `check` refuses
// what the daemon's load refuses.
export function daemonGates(): Gates {
  return createGates({
    config: [{ key: UPDATE_NOTICE_FIELD, allowed: ["false"] }],
    state: [
      { key: UPDATE_NOTICE_SESSION_KEY, allowed: ["false"] },
      { key: UPDATE_DISMISSED_KEY, allowed: [] },
    ],
  });
}
