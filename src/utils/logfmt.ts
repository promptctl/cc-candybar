// logfmt: a value is written bare only when it cannot be misread as more than
// one field; any other value is a JSON string. A value is often what a client
// said (a session id), so no value can open a field or a line of its own.
const BARE = /^[^\s"=\\]+$/;
export const valueOf = (value: string): string =>
  BARE.test(value) ? value : JSON.stringify(value);

// One field of an event line, as it is written.
export type Field = readonly [key: string, value: string];

// [LAW:one-source-of-truth] The one writer of an event line: its kind, then
// each field in order.
export const eventLine = (kind: string, fields: readonly Field[]): string =>
  `${kind}${fields.map(([key, value]) => ` ${key}=${valueOf(value)}`).join("")}`;

// A line's tokens, left to right: a field, a quoted value standing alone, or
// a bare word. A quoted value is consumed whole, so ` key=` inside one is
// text, never a field.
const TOKEN =
  /([^\s"=\\]+)=("(?:[^"\\]|\\.)*"|[^\s"=\\]+)|"(?:[^"\\]|\\.)*"|\S+/g;

// [LAW:one-source-of-truth] The inverse of `valueOf`: every field on a line,
// each value as it was before it was written. The one reader of logged
// fields, so a quoted value (a problem with spaces in it) is never read as
// its first word, and one that embeds another field's spelling shadows
// nothing. A key written twice reads as its last value, as the line reads.
export function fieldsOf(line: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const m of line.matchAll(TOKEN)) {
    if (m[1] === undefined) continue;
    const raw = m[2]!;
    fields.set(m[1], raw.startsWith('"') ? (JSON.parse(raw) as string) : raw);
  }
  return fields;
}

// `key`'s value on a line that holds it; throws on one that does not.
export function fieldOf(line: string, key: string): string {
  const v = fieldsOf(line).get(key);
  if (v === undefined) throw new Error(`no ${key}= on the line: ${line}`);
  return v;
}
