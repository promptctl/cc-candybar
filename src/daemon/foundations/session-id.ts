// [LAW:parse-dont-validate] A session id as the daemon holds it past the door
// it came in by: a render's hook JSON, a subscribe, a click's URL. Every one of
// those is untrusted, and every id keys per-session state, so the checks live
// in this one unit and the brand is their proof.

declare const SESSION_ID: unique symbol;

// [LAW:types-are-the-program] Non-empty, and a safe file name: `<id>.json` is
// a legal name in any folder, so a path built from one needs no check of its
// own. Claude Code's session ids are UUIDs, so no real id is refused.
export type SessionId = string & { readonly [SESSION_ID]: true };

// Room for `.json` inside the 255-byte file-name limit, with a byte to spare.
export const SESSION_ID_MAX_BYTES = 250;

export type ParsedSessionId =
  | { readonly ok: true; readonly id: SessionId }
  | { readonly ok: false; readonly problem: string };

// [LAW:single-enforcer] The one checkpoint for a session id. `problem` reads
// after the caller's name for the field: "field 'session_id' is empty".
export function parseSessionId(raw: unknown): ParsedSessionId {
  const problem =
    typeof raw !== "string"
      ? `is not a string: ${JSON.stringify(raw) ?? String(raw)}`
      : raw === ""
        ? "is empty"
        : raw === "." || raw === ".."
          ? `is ${JSON.stringify(raw)}, which names a folder, not a session`
          : /[/\\\0]/.test(raw)
            ? `contains a path separator or NUL: ${JSON.stringify(raw)}`
            : Buffer.byteLength(raw, "utf8") > SESSION_ID_MAX_BYTES
              ? `is longer than ${SESSION_ID_MAX_BYTES} bytes`
              : null;
  return problem === null
    ? { ok: true, id: raw as SessionId }
    : { ok: false, problem };
}

// [LAW:types-are-the-program] Sessions in recency order, oldest first, as a
// per-session file and a renderer's boot carry them: the order is position,
// so no spelling of an id can move it. A record keyed by id cannot carry it,
// because an integer-like key ("7") enumerates before every other key,
// whatever order it was set in.
export type SessionEntries<V> = ReadonlyArray<readonly [SessionId, V]>;

// [LAW:single-enforcer] Stored entries as their file spelled them: each must be
// an [id, value] pair whose id crosses the checkpoint and appears once. One
// that does not is named to `refused` and dropped, so the entries that remain
// come back branded, in the file's order.
export function sessionEntriesOf(
  list: readonly unknown[],
  refused: (problem: string) => void,
): Map<SessionId, unknown> {
  const entries = new Map<SessionId, unknown>();
  for (const entry of list) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      refused(
        `entry ${JSON.stringify(entry)} is not a [session id, value] pair`,
      );
      continue;
    }
    const [key, value] = entry as [unknown, unknown];
    const id = parseSessionId(key);
    if (!id.ok)
      refused(`session key ${JSON.stringify(key)}: session id ${id.problem}`);
    else if (entries.has(id.id))
      refused(`session key ${JSON.stringify(key)}: session id appears twice`);
    else entries.set(id.id, value);
  }
  return entries;
}

// A session id the program spells itself (check's, a bench's), parsed by the
// same checkpoint: one that fails is a bug in the program, thrown.
export function sessionIdOf(raw: string): SessionId {
  const parsed = parseSessionId(raw);
  if (!parsed.ok) throw new Error(`session id ${parsed.problem}`);
  return parsed.id;
}
