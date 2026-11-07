// [LAW:types-are-the-program] A session's state as the config it renders
// with reads it: every stored value judged by that config's gate
// (Gate.verdict), a foreign one — written under an older config, outside
// what this one's controls can hold — read as absent. A reader that
// INTERPRETS a stored value (the render's `state` variables, a verb deciding
// what a click steps from or which menu is open) demands this type, so
// handing it the raw store is a compile error rather than a reader that
// draws one value while its control steps from another.
//
// Raw reads stay where the stored bytes themselves are the subject: writers,
// undo's and back's "does the target still read as it left it", persistence,
// a recording, a read choosing what a write releases (it runs against the
// reloaded config, under which the released value is foreign by definition),
// and the report of the foreign values themselves.
//
// There is no `values`: no judged reader enumerates a session's keys, and a
// judged enumeration would strip a recording of the stale value its replay
// must show.

import type { Gate } from "./validator-registry";

declare const judgedBrand: unique symbol;

// What a session store answers, stored values as they were written: the
// daemon's SessionState is one.
export interface StoredReads {
  get(sessionId: string, key: string): string | null;
  revision(sessionId: string): number;
}

export interface JudgedState extends StoredReads {
  readonly [judgedBrand]: true;
}

// `gateOf` names the gate of the config `sessionId` renders with, fetched at
// each read: a daemon-wide registration hands the next read a gate with its
// new members, with nothing captured here to go stale.
export function judged(
  reads: StoredReads,
  gateOf: (sessionId: string) => Gate,
): JudgedState {
  const read = {
    get: (sessionId: string, key: string): string | null => {
      const stored = reads.get(sessionId, key);
      return stored === null ||
        gateOf(sessionId).verdict(key, stored).kind === "foreign"
        ? null
        : stored;
    },
    revision: (sessionId: string): number => reads.revision(sessionId),
  };
  // The one place a JudgedState is minted: the brand is what the verdict
  // above earned.
  return read as JudgedState;
}
