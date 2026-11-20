// The key=value fields of one daemon log line. A bracketed value (a JSON list)
// runs to its closing bracket, so it may hold spaces.
export function logFields(line: string): Record<string, string> {
  return Object.fromEntries(
    [...line.matchAll(/(\w+)=(\[.*?\]|\S+)/g)].map(([, key, value]) => [
      key,
      value,
    ]),
  );
}
