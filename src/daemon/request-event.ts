import type { RequestId } from "../renderer/interface.js";
import type { Monotonic } from "../time.js";
import type { LogLevel } from "../utils/logger";
import { eventLine, type Field } from "../utils/logfmt.js";
import type { Failure } from "./verb-error.js";

// The requests that each write one event: a statusline render and a click.
export type RequestKind = "render" | "click";

// [LAW:nothing-unseen] A request as its connection accepted it: which one, in
// the order the daemon accepted them, and when, on the monotonic clock. The id
// is the request's correlation id: its event records it, and a TIMEOUT reply
// carries it, so a client told TIMEOUT finds what its own request became.
export interface Acceptance {
  readonly id: RequestId;
  readonly at: Monotonic;
}

// How one request ended. A request the daemon refused and one whose handler
// threw are outcomes of the same unit of work as one that succeeded, so the
// one event records all three (brandon-unfiled-3248.87p): `bad-request` is
// the client's fault, `threw` the daemon's — a program it ran, or a bug —
// and its stack says which.
export type RequestOutcome = { readonly kind: "ok" } | Failure;

// What a request has learned so far, in the order it learned it. A request
// that stops early carries only the facts it reached, so a field absent from
// the event means "not reached", never "none" (which each field spells `-`).
export type RequestFacts = Field[];

export function noteFacts(
  facts: RequestFacts,
  learned: Readonly<Record<string, string>>,
): void {
  for (const entry of Object.entries(learned)) facts.push(entry);
}

// [LAW:single-enforcer] The level an outcome is logged at, on a request's
// event and on a turn's line alike: a close that cut a click off, or a client
// that left, failed at nothing of its own.
export const LEVEL: Record<RequestOutcome["kind"], LogLevel> = {
  ok: "info",
  "bad-request": "warn",
  threw: "error",
  closing: "info",
  abandoned: "info",
};

// The outcome's own detail: a failure's detail carries an Error's stack.
function detailOf(outcome: RequestOutcome): RequestFacts {
  switch (outcome.kind) {
    case "ok":
      return [];
    case "bad-request":
      return [["problems", outcome.message]];
    case "threw":
      return [["error", outcome.detail]];
    case "closing":
      return [["closing", outcome.message]];
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
    line: eventLine(kind, fields),
  };
}
