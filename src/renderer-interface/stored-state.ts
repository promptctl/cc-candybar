// A renderer's stored state (docs/design/host-and-renderer.md §7): what its
// profile keeps across its restarts, which the host reads, holds and hands in
// as the renderer is built, and which changes only by the writes the
// renderer's turns return.

import { sessionIdOf, type SessionId } from "../daemon/foundations/session-id";
import { isPlainObject } from "../config/loader/validate-core";
import type { Asked } from "../utils/outcome";
import type { Crosses } from "./crosses";
import type { DaemonLogger } from "../utils/logger";
import { isEditModeKey } from "../config/reserved-names";
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

// [LAW:no-silent-failure] Edit mode's own keys live only in an open edit, and
// no edit outlives the renderer, so a profile an older build stored one in
// loads without it, and says which it dropped: one kept would reopen a panel
// or a library on a bar with no edit.
export function withoutEditModeKeys(
  sessions: ReadonlyMap<SessionId, SessionPicks>,
  log: DaemonLogger,
): Map<SessionId, SessionPicks> {
  return new Map(
    [...sessions].map(([session, picks]) => {
      const dropped = Object.keys(picks).filter(isEditModeKey);
      if (dropped.length === 0) return [session, picks];
      log(
        "info",
        `session-state load: dropped ${dropped.join(",")} — no edit outlives the renderer (session=${session})`,
      );
      return [
        session,
        Object.fromEntries(
          Object.entries(picks).filter(([key]) => !isEditModeKey(key)),
        ),
      ];
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
