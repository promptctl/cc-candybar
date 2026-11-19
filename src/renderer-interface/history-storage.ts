// The settings history's shapes and the storage port it saves through: the
// renderer's history writes them, and the host's file stores them
// (src/daemon/history-file.ts).

import { SETTING_PROJECTIONS } from "../config/setting-projections";
import { PLACEMENT_DRAFT_NS } from "../config/loader/edit-mode";
import { type SessionId } from "../daemon/foundations/session-id";
import type { LayerRole } from "../config/layer-role";

// [LAW:types-are-the-program] What a change touched and the two states it
// stepped between. `null` is absence on both kinds: an unset session key, a
// config file that does not exist (a first-ever write created it). Undo writes
// `before`, redo writes `after` — the same write either way.
// [LAW:single-enforcer] A config layer is named by its role in the session's
// chain and a digest of the file that role resolved to, never by its path
// (spec I-10): a step reaches only a file the chain still names, and only the
// one it was made on.
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
      readonly digest: string;
      readonly before: string | null;
      readonly after: string | null;
    };

export type Step = readonly Change[];

export interface SessionHistory {
  readonly past: readonly Step[];
  readonly future: readonly Step[];
}

export const holdsNothing = ({ past, future }: SessionHistory): boolean =>
  past.length + future.length === 0;

export type HistoryState = Readonly<Record<SessionId, SessionHistory>>;

// What a storage loads: each session's history, keyed by a session id the
// storage has already checked.
export type LoadedHistory = ReadonlyMap<SessionId, SessionHistory>;

// [LAW:locality-or-seam] Persistence is the storage's property: the host
// binds a file, or keeps nothing.
export interface HistoryStorage {
  load(): LoadedHistory;
  // The histories as they stand, oldest first, written before it returns, in
  // that order.
  save(state: ReadonlyMap<SessionId, SessionHistory>): void;
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
