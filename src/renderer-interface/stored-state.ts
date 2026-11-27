// A renderer's stored state (docs/design/host-and-renderer.md §7): what its
// profile keeps across its restarts, which the host reads, holds and hands in
// as the renderer is built, and which changes only by the writes the
// renderer's turns return.

import {
  parseSessionId,
  sessionIdOf,
  type SessionId,
} from "../daemon/foundations/session-id";
import { isPlainObject } from "../config/loader/validate-core";
import {
  isNavigationEdit,
  parseTimeline,
  type NavigationWrite,
  type Timeline,
} from "./navigation.js";
import type { Asked } from "../utils/outcome";
import type { Crosses } from "./crosses";
import { kept, type Kept } from "../daemon/foundations/stored-file";
import { isEditModeKey } from "../config/session-key";
import { menuOfKey } from "../config/menu-keys";
import { CLICK_ERROR_KEY, isMenuStateKey } from "../config/reserved-names";
import { isClickErrorRecord } from "../daemon/foundations/click-error";
import {
  parseSessionHistory,
  isHistoryEdit,
  type HistoryState,
  type HistoryEdit,
} from "./history-storage";

// [LAW:one-source-of-truth] Every store the profile holds, as it stands: each
// session's picks and its settings history, in recency order, oldest first.
export interface StoredState {
  readonly sessions: Readonly<Record<SessionId, SessionPicks>>;
  readonly history: HistoryState;
}

// [LAW:types-are-the-program] A peer boot also carries the host's live
// navigation. The durable profile has no field that can store its visits.
export interface LiveSessionState extends StoredState {
  readonly navigation?: Readonly<Record<SessionId, Timeline>>;
}

export type SessionPicks = Readonly<Record<string, string>>;

// [LAW:types-are-the-program] A session's picks hold at least one: a session
// holding none is no state, and takes no slot under a bound.
export function parseSessionPicks(value: unknown): Asked<SessionPicks> {
  if (!isPlainObject(value))
    return { kind: "failed", reason: "is not an object" };
  const keys = Object.keys(value);
  if (keys.length === 0) return { kind: "failed", reason: "holds no picks" };
  const bad = keys.find((key) => typeof value[key] !== "string");
  return bad === undefined
    ? { kind: "ok", value: value as SessionPicks }
    : {
        kind: "failed",
        reason: `has a ${JSON.stringify(bad)} that is not a string`,
      };
}

// Why this build reads nothing of a stored pick, or undefined for one a
// render can read. A key no current spelling mints is never read again and
// never cleared, so it would sit in the profile for good; a click error that
// does not parse would throw in every render of its session.
function retiredBecause(key: string, value: string): string | undefined {
  if (isEditModeKey(key)) return "no edit outlives the renderer";
  // [LAW:one-source-of-truth] Keep the two key/value pairs the old release saved.
  // Both keys still serve other members. Changing today's shared-menu key
  // encoder cannot change the spelling on an old profile's disk.
  if (
    (key === "candybar.tab" && value === "layout") ||
    (key === "menus._candybarZ00002epickers" && value === "toggles")
  )
    return `the "${value}" settings menu was retired and now starts closed`;
  if (isMenuStateKey(key) && menuOfKey(key) === undefined)
    return "no menu is keyed that way in this build";
  if (key === CLICK_ERROR_KEY && !isClickErrorRecord(value))
    return "not a record of a failed click this build reads";
  return undefined;
}

// [LAW:no-silent-failure] A session's picks load without the ones nothing in
// this build reads (edit mode's own, which would reopen a panel or a library
// on a bar with no edit, a menu key this build does not mint, a click error
// it cannot read, or a retired settings menu selection), each named in what
// the load dropped. A session left holding nothing takes no slot.
export function withoutRetiredKeys(
  picks: SessionPicks,
): Asked<Kept<SessionPicks>> {
  const judged = Object.entries(picks).map(
    ([key, value]) => [key, value, retiredBecause(key, value)] as const,
  );
  const dropped = judged.flatMap(([key, , why]) =>
    why === undefined ? [] : [{ part: key, why }],
  );
  const held = judged.flatMap(([key, value, why]) =>
    why === undefined ? [[key, value] as const] : [],
  );
  return held.length === 0
    ? {
        kind: "failed",
        reason: `holds only picks this build reads nothing of: ${dropped.map(({ part, why }) => `${part} (${why})`).join(", ")}`,
      }
    : kept(Object.fromEntries(held), dropped);
}

// [LAW:parse-dont-validate] A replacement can run a different build. A boot
// admits the complete profile or gives the host a reason it could not start.
function profileFields(raw: unknown) {
  if (!isPlainObject(raw))
    throw new Error("renderer boot has no stored profile");
  return raw;
}

function sessionsOf<V>(
  entries: unknown,
  name: keyof LiveSessionState,
  parse: (value: unknown) => Asked<V>,
): Readonly<Record<SessionId, V>> {
  if (!isPlainObject(entries))
    throw new Error(`renderer boot stored.${name} must be an object`);
  return Object.fromEntries(
    Object.entries(entries).map(([key, value]) => {
      const session = sessionIdOf(key);
      const result = parse(value);
      if (result.kind === "failed")
        throw new Error(
          `renderer boot stored.${name} entry ${session} ${result.reason}`,
        );
      return [session, result.value];
    }),
  );
}

function profileOf(fields: Record<string, unknown>): StoredState {
  return {
    sessions: sessionsOf(fields.sessions, "sessions", parseSessionPicks),
    history: sessionsOf(fields.history, "history", parseSessionHistory),
  };
}

export function storedStateOf(raw: unknown): StoredState {
  return profileOf(profileFields(raw));
}

export function liveSessionStateOf(raw: unknown): LiveSessionState {
  const fields = profileFields(raw);
  return {
    ...profileOf(fields),
    ...(fields.navigation !== undefined && {
      navigation: sessionsOf(fields.navigation, "navigation", parseTimeline),
    }),
  };
}

// The profile's stores, empty: a profile nothing was ever stored under.
export const EMPTY_STORED_STATE: StoredState = {
  sessions: {},
  history: {},
};

// [LAW:types-are-the-program] A null pick erases that key. Dropping the
// session also erases keys the receiver held before this turn.
export type ChangedPicks = Readonly<Record<string, string | null>>;

export type PickWrite =
  | {
      readonly kind: "patch";
      readonly store: "session-state";
      readonly key: SessionId;
      readonly changes: ChangedPicks;
    }
  | {
      readonly kind: "drop";
      readonly store: "session-state";
      readonly key: SessionId;
    };

export const durablePickValue = (
  key: string,
  value: string | null,
): string | null =>
  value === null || retiredBecause(key, value) !== undefined ? null : value;

// [LAW:single-enforcer] Convert the live changes to a durable pick record
// at the file or historical-recording boundary. Each new record stands alone
// while an earlier snapshot may still be waiting for its write.
export function storedPicksAfter(
  prior: SessionPicks | undefined,
  write: PickWrite,
): SessionPicks | null {
  if (write.kind === "drop") return null;
  const picks: Record<string, string> = Object.assign(
    Object.create(null),
    prior,
  );
  for (const [key, value] of Object.entries(write.changes)) {
    const kept = durablePickValue(key, value);
    if (kept === null) delete picks[key];
    else picks[key] = kept;
  }
  return Object.keys(picks).length ? picks : null;
}

export type ProfileWrite<Edit = HistoryEdit> =
  | PickWrite
  | {
      readonly kind: "steps";
      readonly store: "settings-history";
      readonly key: SessionId;
      readonly edits: readonly Edit[];
    }
  | {
      readonly kind: "heard";
      readonly store: "session-state" | "settings-history";
      readonly key: SessionId;
    };

// [LAW:parse-dont-validate] The process wire and the durable journal share
// the pick vocabulary. Only a journal also accepts privacy-preserving cuts.
export function isProfileWrite<E>(
  v: unknown,
  edit: (raw: unknown) => raw is E,
): v is ProfileWrite<E> {
  if (!isPlainObject(v) || !parseSessionId(v.key).ok) return false;
  const fields = Object.keys(v).length;
  if (v.store === "settings-history")
    return (
      (v.kind === "heard" && fields === 3) ||
      (v.kind === "steps" &&
        fields === 4 &&
        Array.isArray(v.edits) &&
        v.edits.every(edit))
    );
  return (
    v.store === "session-state" &&
    (((v.kind === "drop" || v.kind === "heard") && fields === 3) ||
      (v.kind === "patch" &&
        fields === 4 &&
        isPlainObject(v.changes) &&
        Object.values(v.changes).every(
          (value) => value === null || typeof value === "string",
        )))
  );
}

export type StoreWrite = ProfileWrite | NavigationWrite;

export function isStoreWrite(raw: unknown): raw is StoreWrite {
  if (!isPlainObject(raw) || raw.store !== "navigation")
    return isProfileWrite(raw, isHistoryEdit);
  return (
    parseSessionId(raw.key).ok &&
    (raw.kind === "drop"
      ? Object.keys(raw).length === 3
      : raw.kind === "navigate" &&
        Object.keys(raw).length === 4 &&
        isNavigationEdit(raw.edit))
  );
}

// [LAW:types-are-the-program] Plain data, so a boot and a turn's output carry
// them as they are.
export const STORED_CROSSES: Crosses<LiveSessionState> = true;
export const WRITES_CROSS: Crosses<StoreWrite> = true;
