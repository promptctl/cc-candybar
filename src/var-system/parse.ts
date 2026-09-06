// [LAW:types-are-the-program] The parse step of a user source (shell / file)
// as a VALUE: what turns the text a reader yields into the value the store
// publishes. `text` is the identity (newlines folded to spaces, trimmed),
// `regex` slices one capture group out of the text, `json` parses the whole
// text as a document — shaped by the store as it is written — whose fields
// templates read by dotted path (`.budget.spent`) — the way an `input` var's
// payload subtree is read.
//
// [LAW:dataflow-not-control-flow] A source runs read → parse → publish on
// every refresh; the parser is data flowing through that ONE pipeline
// (SourceRegistry.declareSource), never a second code path. Each arm carries
// the fallback the author declared in ITS output domain — a string for
// text/regex, a document for json — so an arm and its default cannot
// disagree about their type (the loader's sourceDefaultSpec is the enforcer
// of that pairing; declareOne lowers the authored pair into this union).

import { ok, failed, type Outcome } from "../utils/outcome.js";
import type { JsonValue } from "./types.js";

export type SourceParse =
  | { readonly kind: "text"; readonly default: string | undefined }
  | {
      readonly kind: "regex";
      readonly regex: RegExp;
      readonly default: string | undefined;
    }
  | { readonly kind: "json"; readonly default: JsonValue | undefined };

// A parser is pure: text in, outcome out. Failure is a value naming what
// the text lacked; the pipeline that owns the reader appends WHERE the text
// came from [LAW:effects-at-boundaries].
export type Parser<V> = (text: string) => Outcome<V>;

export const textParser: Parser<string> = (text) =>
  ok(text.replace(/\n/g, " ").trim());

// Capture group 1. A regex that matches with an EMPTY group 1 is a match
// (the author asked for that group; it is empty) — only no match at all,
// or a match whose group 1 did not participate, is a failure.
export function regexParser(regex: RegExp): Parser<string> {
  return (text) => {
    const m = regex.exec(text);
    const group = m?.[1];
    return group === undefined
      ? failed("regex no-match")
      : ok(group.replace(/\n/g, " "));
  };
}

// JSON.parse never yields anything but JSON shapes (the cast is that fact);
// the store re-shapes what it is handed (types.ts toDocument).
export const jsonParser: Parser<JsonValue> = (text) => {
  try {
    return ok(JSON.parse(text) as JsonValue);
  } catch (e) {
    return failed(`JSON parse failed: ${(e as Error).message}`);
  }
};
