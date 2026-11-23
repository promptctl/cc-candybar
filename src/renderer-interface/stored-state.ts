// A renderer's stored state (docs/design/host-and-renderer.md §7): what its
// profile keeps across its restarts, which the host reads, holds and hands in
// as the renderer is built, and which changes only by the writes the
// renderer's turns return.

import { sessionIdOf, type SessionId } from "../daemon/foundations/session-id";
import { isPlainObject } from "../config/loader/validate-core";
import type { Asked } from "../utils/outcome";
import type { Crosses } from "./crosses";
import type { DaemonLogger } from "../utils/logger";
import { isEditModeKey } from "../config/session-key";
import { menuOfKey } from "../config/menu-keys";
import {
  CLICK_ERROR_KEY,
  MENU_NS,
  MENU_PAGE_NS,
} from "../config/reserved-names";
import { isClickErrorRecord } from "../daemon/foundations/click-error";
import {
  parseSessionHistory,
  type HistoryState,
  type SessionHistory,
} from "./history-storage";

// [LAW:one-source-of-truth] Every store the profile holds, as it stands: each
// session's picks and its settings history, in recency order, oldest first.
export interface StoredState {
  readonly sessions: Readonly<Record<SessionId, SessionPicks>>;
  readonly history: HistoryState;
}

export type SessionPicks = Readonly<Record<string, string>>;

export function parseSessionPicks(value: unknown): Asked<SessionPicks> {
  if (!isPlainObject(value))
    return { kind: "failed", reason: "is not an object" };
  const bad = Object.keys(value).find((key) => typeof value[key] !== "string");
  return bad === undefined
    ? { kind: "ok", value: value as SessionPicks }
    : {
        kind: "failed",
        reason: `has a ${JSON.stringify(bad)} that is not a string`,
      };
}

// The key the bar once recorded a failed click under, before it moved into its
// own namespace (reserved-names.ts).
const RETIRED_CLICK_ERROR_KEY = "click.error";

// Why a stored pick reads nothing now, or undefined for one a render can read.
// A key no current spelling mints is never read again and never cleared, so it
// would sit in the profile for good; a click error that does not parse would
// throw in every render of its session.
function retiredBecause(key: string, value: string): string | undefined {
  if (isEditModeKey(key)) return "no edit outlives the renderer";
  if (
    (key.startsWith(MENU_NS) || key.startsWith(MENU_PAGE_NS)) &&
    menuOfKey(key) === undefined
  )
    return "no menu is keyed that way now";
  if (key === RETIRED_CLICK_ERROR_KEY)
    return "a failed click is recorded elsewhere now";
  if (key === CLICK_ERROR_KEY && !isClickErrorRecord(value))
    return "not a record of a failed click";
  return undefined;
}

// [LAW:no-silent-failure] A profile loads without the picks it holds that
// nothing reads (edit mode's own, which would reopen a panel or a library on a
// bar with no edit, the spellings an older build minted, and a click error no
// build wrote), and says which it dropped and why. A session left holding
// nothing takes no slot.
export function withoutRetiredKeys(
  sessions: ReadonlyMap<SessionId, SessionPicks>,
  log: DaemonLogger,
): Map<SessionId, SessionPicks> {
  return new Map(
    [...sessions].flatMap(([session, picks]) => {
      const judged = Object.entries(picks).map(
        ([key, value]) => [key, value, retiredBecause(key, value)] as const,
      );
      const dropped = judged.filter(([, , why]) => why !== undefined);
      if (dropped.length === 0) return [[session, picks] as const];
      log(
        "info",
        `session-state load: dropped ${dropped.map(([key, , why]) => `${key} (${why})`).join(", ")} (session=${session})`,
      );
      const kept = judged.flatMap(([key, value, why]) =>
        why === undefined ? [[key, value] as const] : [],
      );
      return kept.length === 0
        ? []
        : [[session, Object.fromEntries(kept)] as const];
    }),
  );
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

// [LAW:types-are-the-program] One entry of one store as a turn left it: a
// session's picks or history, which null drops.
// A write of an entry already held moves it to the end of its store's
// recency order, as the renderer's own store moved it.
export type StoreWrite =
  | {
      readonly store: "session-state";
      readonly key: SessionId;
      readonly value: SessionPicks | null;
    }
  | {
      readonly store: "settings-history";
      readonly key: SessionId;
      readonly value: SessionHistory | null;
    };

// [LAW:types-are-the-program] Plain data, so a boot and a turn's output carry
// them as they are.
export const STORED_CROSSES: Crosses<StoredState> = true;
export const WRITES_CROSS: Crosses<StoreWrite> = true;
