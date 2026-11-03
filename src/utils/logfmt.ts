// logfmt: a value is written bare only when it cannot be misread as more than
// one field; any other value is a JSON string. A value is often what a client
// said (a session id), so no value can open a field or a line of its own.
const BARE = /^[^\s"=\\]+$/;
export const valueOf = (value: string): string =>
  BARE.test(value) ? value : JSON.stringify(value);

// [LAW:one-source-of-truth] The inverse: `key`'s value as it was before
// `valueOf`, read off a line that holds it. The one reader of a logged field,
// so a quoted value (a problem with spaces in it) is never read as its first
// word. Throws when the line carries no such field.
export function fieldOf(line: string, key: string): string {
  const m = new RegExp(
    `(?:^| )${key}=("(?:[^"\\\\]|\\\\.)*"|[^\\s"=\\\\]+)`,
  ).exec(line);
  if (m === null) throw new Error(`no ${key}= on the line: ${line}`);
  const raw = m[1]!;
  return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
}
