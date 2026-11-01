import { inspect } from "node:util";

import type { LogLevel } from "../utils/logger";
import { valueOf } from "../utils/logfmt.js";

// The requests that each write one event: a statusline render and a click.
export type RequestKind = "render" | "click";

// How one request ended. A request the daemon refused and one whose handler
// threw are outcomes of the same unit of work as one that succeeded, so the
// one event records all three (brandon-unfiled-3248.87p): `bad-request` is
// the client's fault, `threw` the daemon's — a program it ran, or a bug —
// and its stack says which.
export type RequestOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "bad-request"; readonly problems: readonly string[] }
  | { readonly kind: "threw"; readonly error: unknown }
  // The click met the daemon's close, or its client had left: neither failed.
  | { readonly kind: "closing"; readonly error: Error }
  | { readonly kind: "abandoned"; readonly error: Error };

// What a request has learned so far, in the order it learned it. A request
// that stops early carries only the facts it reached, so a field absent from
// the event means "not reached", never "none" (which each field spells `-`).
export type RequestFacts = Array<readonly [key: string, value: string]>;

export function noteFacts(
  facts: RequestFacts,
  learned: Readonly<Record<string, string>>,
): void {
  for (const entry of Object.entries(learned)) facts.push(entry);
}

const LEVEL: Record<RequestOutcome["kind"], LogLevel> = {
  ok: "info",
  "bad-request": "warn",
  threw: "error",
  closing: "info",
  abandoned: "info",
};

// The outcome's own detail. A thrown value is described by `inspect`, which
// is total over anything a handler can throw and carries an Error's stack.
function detailOf(outcome: RequestOutcome): RequestFacts {
  switch (outcome.kind) {
    case "ok":
      return [];
    case "bad-request":
      return [["problems", outcome.problems.join("; ")]];
    case "threw":
      return [["error", inspect(outcome.error)]];
    case "closing":
      return [["closing", outcome.error.message]];
    case "abandoned":
      return [["abandoned", "1"]];
  }
}

// [LAW:nothing-unseen][LAW:single-enforcer] The one request event: every
// request writes this line once, whatever its outcome, so the requests that
// fail are described by the same fields as the ones that succeed, and every
// request kind is read the same way: its name, then each fact as a logfmt
// field.
export function requestEvent(
  kind: RequestKind,
  facts: RequestFacts,
  outcome: RequestOutcome,
  tookMs: number,
): { readonly level: LogLevel; readonly line: string } {
  const fields: RequestFacts = [
    ...facts,
    ["took", `${tookMs}ms`],
    ["outcome", outcome.kind],
    ...detailOf(outcome),
  ];
  return {
    level: LEVEL[outcome.kind],
    line: `${kind}${fields.map(([key, value]) => ` ${key}=${valueOf(value)}`).join("")}`,
  };
}
