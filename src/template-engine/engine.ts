// [LAW:one-source-of-truth] One Engine instance covers all segment template
// evaluation. Callers parse their template once (engine.parse(src)) and call
// template.evaluate(scope) per render — the expensive parse step is not
// repeated per render cycle.
//
// Function registry (closed set for cc-candybar):
//  • Go builtins (always registered by the engine): printf, print, println,
//    eq/ne/lt/gt/le/ge, and/or/not, len, index, slice, call.
//  • sprigDefaults: default, empty, coalesce, ternary, fromJson, toJson.
//  • sprigStrings: trunc, lower, upper, replace, trim/trimPrefix/trimSuffix,
//    split/join, contains, hasPrefix, hasSuffix, and more string utils.
//  • sprigLists: has (membership test: `has "v" $list`).
//  • richTextFuncs: bold, italic, red, green, … (styling from rich-js).
//  • paletteFuncs (when resolver provided): primary, accent, palette, paletteOver, auto.
//  • ccCandybarFuncs: basename, dirname, int, string, bool.

import {
  createEngine,
  type Engine,
  sprigDefaults,
  sprigStrings,
  sprigLists,
} from "@promptctl/go-template-js";
import { richTextFuncs, RichText, PaletteResolver } from "rich-js";
import { paletteFuncs } from "rich-js/template-bindings";
import { ccCandybarFuncs } from "./funcs.js";

// [LAW:single-enforcer] fromString/toString are declared once here.
// richTextFuncs() provides style functions (bold, red, link, …).
// paletteFuncs(resolver) registers semantic palette functions when a theme
// resolver is provided — same engine instance, no second parse path.
// [LAW:one-type-per-behavior] resolver? is a value, not a mode — one factory,
// one engine shape; the data (resolver presence) governs what's registered.
export function createCcCandybarEngine(resolver?: PaletteResolver): Engine<RichText> {
  return createEngine<RichText>({
    fromString: (s) => new RichText(s),
    toString: (rt) => rt.plain,
    funcs: {
      ...sprigDefaults(),
      ...sprigStrings(),
      ...sprigLists(),
      ...richTextFuncs(),
      ...(resolver !== undefined ? paletteFuncs(resolver) : {}),
      // Domain-specific overrides last (wins on collision with sprig aliases).
      ...ccCandybarFuncs(),
    },
  });
}
