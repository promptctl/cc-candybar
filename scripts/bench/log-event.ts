// A request event as the daemon's log holds it: an ISO timestamp, then
// logfmt fields. Every bench that reads one reads it through here.

import { fieldOf } from "../../src/utils/logfmt.js";

// When the event was logged, epoch ms.
export function atOf(line: string): number {
  const at = Date.parse(line.slice(0, 24));
  if (Number.isNaN(at)) throw new Error(`no timestamp opens the line: ${line}`);
  return at;
}

// A duration field (`took=12ms`) in ms.
export function msOf(line: string, key: string): number {
  const v = fieldOf(line, key);
  if (!v.endsWith("ms"))
    throw new Error(`${key}=${v} is not a duration: ${line}`);
  return Number(v.slice(0, -2));
}
