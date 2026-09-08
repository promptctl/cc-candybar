// [LAW:one-source-of-truth] One Engine; callers parse once, evaluate per render.

import {
  createEngine,
  type Engine,
  type FuncMap,
  sprigDefaults,
  sprigStrings,
  sprigLists,
  sprigMath,
  sprigDatetime,
  sprigConversions,
  sprigDicts,
} from "@promptctl/go-template-js";
import { RichText } from "@promptctl/rich-js";
import { richTextFuncs } from "@promptctl/rich-js/template-bindings";
import { ccCandybarFuncs, formatterFuncs } from "./funcs.js";

// [LAW:single-enforcer] fromString/toString are declared once here.
// [LAW:one-way-deps] `extraFuncs` is injected, so the dependency runs caller →
// engine and the generic engine never imports a feature.
// [LAW:one-type-per-behavior] Its presence is a value, not a mode.
// [LAW:single-enforcer] `clock` is the one time source, defaulted here so the
// literal lives in exactly one place.
export function createCcCandybarEngine(
  extraFuncs?: FuncMap,
  clock: () => Date = () => new Date(),
): Engine<RichText> {
  return createEngine<RichText>({
    fromString: (s) => new RichText(s),
    toString: (rt) => rt.plain,
    // A bare document prints as Go prints a map, not as leaked object text.
    isT: (v): v is RichText => v instanceof RichText,
    clock,
    // [LAW:no-defensive-null-guards] Callers drive varDefault off MissingFieldError.
    missingKey: "error",
    funcs: {
      ...sprigDefaults(),
      ...sprigStrings(),
      ...sprigLists(),
      ...sprigMath(),
      // [LAW:single-enforcer] one clock seam: the same source createEngine holds.
      ...sprigDatetime(clock),
      ...sprigConversions(),
      // [LAW:types-are-the-program] How a helper takes >1 input through its dot arg.
      ...sprigDicts(),
      ...richTextFuncs(),
      // [LAW:one-source-of-truth] Position IS the override policy; `int` is the cast.
      ...ccCandybarFuncs(),
      // [LAW:one-source-of-truth] Registered last so `round` means Math.round here.
      ...formatterFuncs(clock),
      // [LAW:locality-or-seam] Last, so an injected feature can override.
      ...(extraFuncs ?? {}),
    },
  });
}
