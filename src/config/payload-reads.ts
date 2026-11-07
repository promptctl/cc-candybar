// Which payload paths a config's templates read: the doctor asks it of one
// segment (src/doctor/data-needs.ts), and a renderer asks it of the whole
// config to declare the built-ins it gathers (src/daemon/cache/render.ts).
//
// [LAW:single-enforcer] One walk, two callers. A read is found by the one fold
// of what a value reads (src/config/loader/value-reads.ts): a template's reads
// and the texts of the actions it binds, a variable's template, cache key and
// depends_on. A payload read is an input's path or a source's name
// (`payloadPathOf`), and nothing else in a config reads the payload.
//
// [LAW:no-silent-failure] A read this walk misses is no blank: the payload
// spells a built-in the declaration left out as `Undeclared`, and an input
// reading it throws (src/var-system/sources.ts), so the segment draws ⚠ and
// `cc-candybar check` fails on it.

import { walkNodes, type DslConfig } from "./dsl-types.js";
import { declaredVariables } from "./loader/refs.js";
import { payloadPathOf, valueReadsOf } from "./loader/value-reads.js";
import { presetGlobals, presetNames, presetRoot } from "./presets.js";
import { EXPRESSION_SLOTS, isExpression } from "../themes/policy.js";

// One segment's own templates: what its reads start from. A partial's body is
// seeded directly (not resolved through its segment's `{{ template "name" }}`
// dispatch) so a payload read inside it is reached whether or not the fold
// can resolve the dispatch name.
function segmentTemplates(config: DslConfig, name: string): string[] {
  const seg = config.segments[name];
  if (!seg) return [];
  return [
    ...[seg.template, seg.when, seg.bg, seg.fg].flatMap((src) =>
      src ? [src] : [],
    ),
    ...Object.values(seg.partials ?? {}),
  ];
}

// The payload paths a set of templates reaches, through every edge of the
// fold: each variable a template reads, and on through what that variable
// reads.
function pathsReached(
  config: DslConfig,
  templates: readonly string[],
): ReadonlySet<string> {
  const reads = valueReadsOf(config);
  const decls = new Map(declaredVariables(config));
  const frontier = templates.flatMap((template) =>
    reads.ofTemplate(template).flatMap(({ reaches }) => reaches),
  );
  const visited = new Set<string>();
  const paths = new Set<string>();
  while (frontier.length > 0) {
    const reached = frontier.pop()!;
    if (visited.has(reached)) continue;
    visited.add(reached);
    const decl = decls.get(reached)!;
    const read = payloadPathOf(reached, decl);
    if (read !== undefined) paths.add(read);
    for (const { reaches } of reads.ofVariable(decl)) frontier.push(...reaches);
  }
  return paths;
}

// The payload paths one segment reads: its own templates and each
// placement's `when`.
export function segmentInputPaths(
  config: DslConfig,
  name: string,
  whens: readonly string[],
): ReadonlySet<string> {
  return pathsReached(config, [...segmentTemplates(config, name), ...whens]);
}

// [LAW:one-source-of-truth] The payload paths a config's draws can read, over
// EVERY preset, so a session's pick of one moves nothing it gathers: each
// layout node's `when`, each placed segment's templates, and each preset's
// globals rules. These are what a draw evaluates. A cell an edit-mode click
// inserts is written to the file, and the reload's state walks it.
export function configPayloadPaths(config: DslConfig): ReadonlySet<string> {
  const templates: string[] = [];
  for (const preset of presetNames(config.presets)) {
    for (const node of walkNodes(presetRoot(config, preset).node)) {
      if (node.when) templates.push(node.when);
      if (node.kind === "segment") {
        templates.push(...segmentTemplates(config, node.name));
      }
    }
    const globals = presetGlobals(config, preset);
    for (const slot of EXPRESSION_SLOTS) {
      const rule = globals[slot];
      if (isExpression(rule)) templates.push(rule);
    }
  }
  return pathsReached(config, templates);
}
