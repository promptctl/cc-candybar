// [LAW:one-source-of-truth] Cast semantics live in var-system/types.ts.
// This module wraps them as FuncMap entries — it does not duplicate logic.
// [LAW:single-enforcer] The boundary gate (argTypes) lives at the engine
// dispatch site; the bodies here trust the runtime types they declared.

import { basename as pathBasename, dirname as pathDirname } from "path";
import type { FuncMap } from "@promptctl/go-template-js";
import {
  toNumber,
  toString,
  toBool,
  type VarValue,
} from "../var-system/types.js";

// cc-candybar-specific functions not already covered by sprig or Go builtins.
// The engine also includes sprigDefaults(), sprigStrings(), and sprigLists()
// which cover: default, trunc, lower, upper, replace, trim/trimPrefix/trimSuffix,
// split/join, contains/hasPrefix/hasSuffix, has.
// Go builtins cover: printf, eq/ne/lt/gt/le/ge, and/or/not.
export function ccCandybarFuncs(): FuncMap {
  return {
    // Path operations absent from sprig in this package.
    basename: {
      fn: (s: string) => pathBasename(s),
      argTypes: ["string"],
    },
    dirname: {
      fn: (s: string) => pathDirname(s),
      argTypes: ["string"],
    },

    // [LAW:single-enforcer] Type casts delegate to var-system/types.ts.
    // "value" argType: these funcs enforce their own constraints and emit
    // a useful TypeError on ambiguous input — no need for the engine gate
    // to pre-filter (it can't describe the partial-cast semantics anyway).
    int: {
      fn: (v: VarValue) => toNumber(v),
      argTypes: ["value"],
    },
    string: {
      fn: (v: VarValue) => toString(v),
      argTypes: ["value"],
    },
    bool: {
      fn: (v: VarValue) => toBool(v),
      argTypes: ["value"],
    },

    // [LAW:single-enforcer] One URL-encoding function for click-verb URL
    // construction in templates. encodeURIComponent matches the legacy
    // src/segments/renderer.ts toolbar/tray renderers, so DSL-emitted
    // cc-candybar://verb/<value> URLs are byte-identical to legacy ones.
    // [LAW:types-are-the-program] Domain primitive surfaced by chunk-7/8
    // migration (vhi.3) — the proposal explicitly budgets "may add one or
    // two filters during migration." This is one of those.
    urlEncode: {
      fn: (s: string) => encodeURIComponent(s),
      argTypes: ["string"],
    },
  };
}
