// [LAW:types-are-the-program] No variable is declared under another declared
// variable. Where one is, a read of the inner name means two things: the draw's
// scope proxy takes the first declared name the read reaches and hands back a
// field of it, and the load's walks resolve the longest. With no nesting there
// is one name a read can land on, so every resolver agrees (`variableRead`).
//
// [LAW:single-enforcer] Checked once, over the names the store is declared
// from: those of the config validateRenderable returns, after every synthesis pass,
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
  names: {
    // The nestings this check reports: those with a name in it.
    readonly checked: (name: string) => boolean;
    // The names the file being checked declares, which are its to rename.
    readonly authored: (name: string) => boolean;
  },
): void {
  // Each store name, at the config path that declares it.
  const declaredAt = new Map(
    [...declarationsAt(cfg)].map(([name, , at]) => [name, at] as const),
  );
  for (const [inner, innerAt] of declaredAt) {
    const parts = inner.split(".");
    for (let n = 1; n < parts.length; n++) {
      const outer = parts.slice(0, n).join(".");
      const outerAt = declaredAt.get(outer);
      if (
        outerAt === undefined ||
        !(names.checked(inner) || names.checked(outer))
      ) {
        continue;
      }
      // [LAW:no-silent-failure] The error points at a name the file can
      // rename: when only one of the two is the file's, the other is the
      // bundled default's, a plugin's or a control the bar builds.
      const [mine, theirs, at] = names.authored(inner)
        ? ([inner, outer, innerAt] as const)
        : ([outer, inner, outerAt] as const);
      const fix =
        names.authored(inner) === names.authored(outer)
          ? "Rename one so neither name starts with the other."
          : `"${theirs}" is declared outside this file (the bundled default, a plugin, or a control the bar builds), so rename "${mine}".`;
      ctx.issues.push({
        path: at.join("."),
        message: `variable "${inner}" is declared under the variable "${outer}" — a read of ".${inner}" would name both, "${inner}" and a field of "${outer}". ${fix}`,
        line: findKeyLine(ctx.source, [...at]),
      });
    }
  }
}
