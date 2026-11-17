// The settings history's shapes: what a session's steps hold, as the
// renderer keeps them and its stored state carries them.

import { SETTING_PROJECTIONS } from "../config/setting-projections";
import { PLACEMENT_DRAFT_NS } from "../config/loader/edit-mode";
import type { LayerRole } from "../config/layer-role";

// [LAW:types-are-the-program] What a change touched and the two states it
// stepped between. `null` is absence on both kinds: an unset session key, a
// config file that does not exist (a first-ever write created it). Undo writes
// `before`, redo writes `after` — the same write either way. A layer is named
// by its role in the session's chain, never by a path (I-10): which file that
// is, is the chain's to say when the step is taken, and `file` is the digest
// of the one it named when the step was made, so a step never lands in a file
// it did not write.
export type Change =
  | {
      readonly kind: "session";
      readonly key: string;
      readonly before: string | null;
      readonly after: string | null;
    }
  | {
      readonly kind: "layer";
      readonly role: LayerRole;
      readonly file: string;
      readonly before: string | null;
      readonly after: string | null;
    };

export type Step = readonly Change[];

export interface SessionHistory {
  readonly past: readonly Step[];
  readonly future: readonly Step[];
  // The savepoint edit mode opened at. Present exactly while edit mode is
  // open.
  readonly savepoint?: Savepoint;
}

// [LAW:types-are-the-program] What cancelling edit mode needs, as one value.
// `net` is the change since edit mode opened, one Change per target: from the
// value it held when edit mode opened to the value this history last wrote
// there — whichever clicks, undos and redos got it there. Cancel is applying
// `net` backwards, through the same all-or-nothing `apply` a `↶` takes, so it
// does not depend on how the stack moved meanwhile: the cap trimming steps
// made in edit mode, a `↶` below where it opened, a fresh step abandoning the
// redo stack. `at` and `below` give the stack back the shape it had: `at` is
// how many steps of `past` were there when edit mode opened, and `below` the
// steps from before it that a fresh step in edit mode abandoned off the redo
// stack after a `↶` took them back — in order, right above `at`.
export interface Savepoint {
  readonly at: number;
  readonly net: Step;
  readonly below: readonly Step[];
}

// [LAW:one-source-of-truth] The session keys a settings control writes: a
// display setting's, and every placement setting's unsaved value, which
// configure mode mints under one namespace. Every other session key — an open
// menu, a page cursor, the edit-mode toggle — is the menu's own state, and
// undoing it would be undoing navigation.
const SETTING_SESSION_KEYS: ReadonlySet<string> = new Set(
  SETTING_PROJECTIONS.map((s) => s.sessionKey),
);

export const isSettingKey = (key: string): boolean =>
  SETTING_SESSION_KEYS.has(key) || key.startsWith(PLACEMENT_DRAFT_NS);
