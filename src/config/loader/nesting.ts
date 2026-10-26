// [LAW:types-are-the-program] No variable is declared under another declared
// variable. Where one is, a read of the inner name means two things: the draw's
// scope proxy takes the first declared name the read reaches and hands back a
// field of it, and the load's walks resolve the longest. With no nesting there
// is one name a read can land on, so every resolver agrees (`variableRead`).
//
// [LAW:single-enforcer] Checked once, over the names the store is declared
// from: those of the config validateConfig returns, after every synthesis pass,
// since a synthesized name is built from authored ones and two of them can
// nest. A plugin's own names are checked as it joins its layer, so its nesting
// drops that plugin alone.

import type { DslConfig } from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import { declarationsAt } from "./refs.js";
import type { ValidateCtx } from "./validate-core.js";

export function validateNoNesting(
  ctx: ValidateCtx,
  cfg: Pick<DslConfig, "variables" | "segments">,
  subject: (name: string) => boolean = () => true,
): void {
  // Each store name, at the config path that declares it.
  const declaredAt = new Map(
    [...declarationsAt(cfg)].map(([name, , at]) => [name, at] as const),
  );
  for (const [inner, at] of declaredAt) {
    const parts = inner.split(".");
    for (let n = 1; n < parts.length; n++) {
      const outer = parts.slice(0, n).join(".");
      if (!declaredAt.has(outer) || !(subject(inner) || subject(outer))) {
        continue;
      }
      ctx.issues.push({
        path: at.join("."),
        message: `variable "${inner}" is declared under the variable "${outer}" — a read of ".${inner}" would name both, "${inner}" and a field of "${outer}". Rename one so neither name starts with the other.`,
        line: findKeyLine(ctx.source, [...at]),
      });
    }
  }
}
