// logfmt: a value is written bare only when it cannot be misread as more than
// one field; any other value is a JSON string. A value is often what a client
// said (a session id), so no value can open a field or a line of its own.
const BARE = /^[^\s"=\\]+$/;
export const valueOf = (value: string): string =>
  BARE.test(value) ? value : JSON.stringify(value);
