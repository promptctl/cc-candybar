import { inspect } from "node:util";

import type { LogLevel } from "./log";
import { valueOf } from "../utils/logfmt.js";

// How one render request ended. A render the daemon refused and a render that
// threw are outcomes of the same unit of work as one that drew a bar, so the
// one event records all three (brandon-unfiled-3248.87p).
export type RenderOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "bad-request"; readonly problems: readonly string[] }
  | { readonly kind: "threw"; readonly error: unknown };

// What a render has learned so far, in the order it learned it. A render that
// stops early carries only the facts it reached, so a field absent from the
// event means "not reached", never "none" (which each field spells `-`).
export type RenderFacts = Array<readonly [key: string, value: string]>;

export function noteFacts(
  facts: RenderFacts,
  learned: Readonly<Record<string, string>>,
): void {
  for (const entry of Object.entries(learned)) facts.push(entry);
}

const LEVEL: Record<RenderOutcome["kind"], LogLevel> = {
  ok: "info",
  "bad-request": "warn",
  threw: "error",
};

// The outcome's own detail. A thrown value is described by `inspect`, which
// is total over anything a render can throw and carries an Error's stack.
function detailOf(outcome: RenderOutcome): RenderFacts {
  switch (outcome.kind) {
    case "ok":
      return [];
    case "bad-request":
      return [["problems", outcome.problems.join("; ")]];
    case "threw":
      return [["error", inspect(outcome.error)]];
  }
}

// [LAW:nothing-unseen] The one render event: every render request writes this
// line once, whatever its outcome, so the renders that fail are described by
// the same fields as the ones that succeed.
export function renderEvent(
  facts: RenderFacts,
  outcome: RenderOutcome,
  tookMs: number,
): { readonly level: LogLevel; readonly line: string } {
  const fields: RenderFacts = [
    ...facts,
    ["took", `${tookMs}ms`],
    ["outcome", outcome.kind],
    ...detailOf(outcome),
  ];
  return {
    level: LEVEL[outcome.kind],
    line: `render${fields.map(([key, value]) => ` ${key}=${valueOf(value)}`).join("")}`,
  };
}
