// A renderer's stored state (docs/design/host-and-renderer.md §7): what its
// profile keeps across its restarts, which the host reads, holds and hands in
// as the renderer is built, and which changes only by the writes the
// renderer's turns return.

import { sessionIdOf, type SessionId } from "../daemon/foundations/session-id";
import { isPlainObject } from "../config/loader/validate-core";
import type { Asked } from "../utils/outcome";
import type { Crosses } from "./crosses";
import { kept, type Kept } from "../daemon/foundations/stored-file";
import { isEditModeKey } from "../config/session-key";
import { menuOfKey } from "../config/menu-keys";
import { CLICK_ERROR_KEY, isMenuStateKey } from "../config/reserved-names";
import { isClickErrorRecord } from "../daemon/foundations/click-error";
import {
  parseSessionHistory,
  type HistoryState,
  type HistoryEdit,
} from "./history-storage";

// [LAW:one-source-of-truth] Every store the profile holds, as it stands: each
// session's picks and its settings history, in recency order, oldest first.
export interface StoredState {
  readonly sessions: Readonly<Record<SessionId, SessionPicks>>;
  readonly history: HistoryState;
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
export function storedStateOf(raw: unknown): StoredState {
  if (!isPlainObject(raw))
    throw new Error("renderer boot has no stored profile");
  const sessionsOf = <V>(
    name: keyof StoredState,
    parse: (value: unknown) => Asked<V>,
  ): Readonly<Record<SessionId, V>> => {
    const entries = raw[name];
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
  };
  return {
    sessions: sessionsOf("sessions", parseSessionPicks),
    history: sessionsOf("history", parseSessionHistory),
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
    if (value === null || retiredBecause(key, value) !== undefined)
      delete picks[key];
    else picks[key] = value;
  }
  return Object.keys(picks).length ? picks : null;
}

export type StoreWrite =
  | PickWrite
  | {
      readonly kind: "steps";
      readonly store: "settings-history";
      readonly key: SessionId;
      readonly edits: readonly HistoryEdit[];
    }
  | {
      readonly kind: "heard";
      readonly store: "session-state" | "settings-history";
      readonly key: SessionId;
    };

// [LAW:types-are-the-program] Plain data, so a boot and a turn's output carry
// them as they are.
export const STORED_CROSSES: Crosses<StoredState> = true;
export const WRITES_CROSS: Crosses<StoreWrite> = true;
