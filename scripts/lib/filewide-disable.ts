// [LAW:single-enforcer] ESLint parses directive names and rule lists. Its
// normal suppression happens after linting, so the coverage decision must
// remain outside the rules a source can turn off.
import { ConfigCommentParser } from "@eslint/plugin-kit";
import { parse } from "@typescript-eslint/parser";
import type { ESLint } from "eslint";
import fs from "node:fs";

const directives = new ConfigCommentParser();

export function filewideDisableLine(
  result: ESLint.LintResult,
): number | undefined {
  // The normal pass reports all unused directives, including those in clean
  // files. Inspect syntax only where ESLint found suppression or a directive
  // diagnostic. Its fatal diagnostics already fail unparseable sources.
  if (
    result.fatalErrorCount ||
    (!result.suppressedMessages.length &&
      !result.messages.some((m) => m.ruleId === null))
  )
    return;
  const { comments, tokens } = parse(
    result.source ?? fs.readFileSync(result.filePath, "utf8"),
    {
      filePath: result.filePath,
      range: true,
      loc: true,
      tokens: true,
      comment: true,
    },
  );
  let next = 0;
  let disabled: number | undefined;
  let covering: number | undefined;
  for (const comment of comments) {
    if (comment.type !== "Block") continue;
    const directive = directives.parseDirective(comment.value);
    if (
      !directive ||
      (directive.label !== "eslint-disable" &&
        directive.label !== "eslint-enable") ||
      Object.keys(directives.parseListConfig(directive.value)).length
    )
      continue;
    while (next < tokens.length && tokens[next]!.range[0] < comment.range[0]) {
      if (disabled === undefined) return;
      covering = disabled;
      next++;
    }
    disabled =
      directive.label === "eslint-disable" ? comment.loc.start.line : undefined;
  }
  if (next < tokens.length && disabled === undefined) return;
  return covering ?? disabled;
}
