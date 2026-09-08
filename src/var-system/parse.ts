// [LAW:types-are-the-program] The parse step of a shell/file source as a VALUE.
// [LAW:dataflow-not-control-flow] Each arm carries its default in its own output domain (string for text/regex, document for json), so the two cannot disagree.

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

// [LAW:effects-at-boundaries] Pure: text in, outcome out; the pipeline appends WHERE the text came from.
export type Parser<V> = (text: string) => Outcome<V>;

// [LAW:one-source-of-truth] The one fold every string arm applies; a stray `\r` would move the terminal's cursor.
const LINE_BREAK = /\r\n|\r|\n/g;

export const textParser: Parser<string> = (text) =>
  ok(text.replace(LINE_BREAK, " ").trim());

// An EMPTY group 1 is a match; only no match, or a group that did not participate, fails.
export function regexParser(regex: RegExp): Parser<string> {
  return (text) => {
    const m = regex.exec(text);
    const group = m?.[1];
    return group === undefined
      ? failed("regex no-match")
      : ok(group.replace(LINE_BREAK, " "));
  };
}

export const jsonParser: Parser<JsonValue> = (text) => {
  try {
    return ok(JSON.parse(text) as JsonValue);
  } catch (e) {
    return failed(`JSON parse failed: ${(e as Error).message}`);
  }
};
