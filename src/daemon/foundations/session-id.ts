// [LAW:parse-dont-validate] A session id as the daemon holds it past the door
// it came in by: a render's hook JSON, a subscribe, a click's URL. Every one of
// those is untrusted, and every id keys per-session state, so the checks live
// in this one unit and the brand is their proof.

declare const SESSION_ID: unique symbol;

// [LAW:types-are-the-program] Non-empty, a safe file name, and never an array
// index. `<id>.json` is a legal name in any folder, so a path built from one
// needs no check of its own. A record lists its array-index keys first, and
// every other key in the order it was set, so a record keyed by session ids
// keeps the order the bounded stores evict by through every save and load.
// Claude Code's session ids are UUIDs, so no real id is refused.
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
          : isArrayIndex(raw)
            ? `is ${JSON.stringify(raw)}, an array index, which a record keyed by session id lists before every other key`
            : /[/\\\0]/.test(raw)
              ? `contains a path separator or NUL: ${JSON.stringify(raw)}`
              : Buffer.byteLength(raw, "utf8") > SESSION_ID_MAX_BYTES
                ? `is longer than ${SESSION_ID_MAX_BYTES} bytes`
                : null;
  return problem === null
    ? { ok: true, id: raw as SessionId }
    : { ok: false, problem };
}

// The keys a JS object lists ahead of the rest, ascending: the canonical
// spelling of an integer from 0 to 2^32 - 2. "07", "1e3" and "4294967295" are
// not among them, and keep their place like any other key.
function isArrayIndex(raw: string): boolean {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < 2 ** 32 - 1 && String(n) === raw;
}

// [LAW:single-enforcer] A stored record keyed by session id, as its file
// spelled it: each key crosses the checkpoint, and one it refuses is named to
// `refused` and dropped, so the keys that remain come back branded.
export function sessionKeyed<V>(
  record: Readonly<Record<string, V>>,
  refused: (key: string, problem: string) => void,
): Map<SessionId, V> {
  const keyed = new Map<SessionId, V>();
  for (const [key, value] of Object.entries(record)) {
    const id = parseSessionId(key);
    if (id.ok) keyed.set(id.id, value);
    else refused(key, id.problem);
  }
  return keyed;
}

// A session id the program spells itself (check's, a bench's), parsed by the
// same checkpoint: one that fails is a bug in the program, thrown.
export function sessionIdOf(raw: string): SessionId {
  const parsed = parseSessionId(raw);
  if (!parsed.ok) throw new Error(`session id ${parsed.problem}`);
  return parsed.id;
}
