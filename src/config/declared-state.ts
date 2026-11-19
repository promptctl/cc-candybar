// The session state edit chrome keeps that a config still declares.
//
// [LAW:one-source-of-truth] Edit chrome declares a state variable for every
// session key it keeps for an editable placement (its drafts, its `✚`
// libraries and their pages, its configure lists), and a configure action for
// every member `edit.configure` may hold. So the config a session renders is
// the one record of which of those keys still stand: a key in edit chrome's
// namespaces that it does not declare, or a configure value it names no
// action for, belongs to a placement it no longer edits, and a later
// placement of the same id would inherit it. Nothing is read back off a key.

import type { DslConfig } from "./dsl-types.js";
import { EDIT_CHROME_STATE_NS } from "./edit-chrome.js";
import { EDIT_CONFIGURE_KEY } from "./loader/edit-mode.js";

// What a config's declarations admit of a session's state: whether the key
// `key`, holding `value`, still stands.
export interface DeclaredState {
  holds(key: string, value: string): boolean;
}

// What a load that failed or dropped a placement admits: everything, since the
// config it draws is not all of what its files say.
export const EVERY_KEY_STANDS: DeclaredState = { holds: () => true };

// [LAW:carrying-cost] Built once per loaded config: a render compares its
// identity, and a release asks it of each key the session holds.
export function declaredStateOf(config: DslConfig): DeclaredState {
  const declared = new Map(
    Object.values(config.variables).flatMap((v) =>
      v.kind === "state" ? [[v.key, v.default] as const] : [],
    ),
  );
  const members = new Set(
    Object.values(config.actions).flatMap((a) =>
      "set" in a && a.set === EDIT_CONFIGURE_KEY && "to" in a ? [a.to] : [],
    ),
  );
  const chrome = (key: string): boolean =>
    EDIT_CHROME_STATE_NS.some((ns) => key.startsWith(ns));
  return {
    holds: (key, value) =>
      !chrome(key) ||
      (declared.has(key) &&
        (key !== EDIT_CONFIGURE_KEY ||
          value === declared.get(key) ||
          members.has(value))),
  };
}
