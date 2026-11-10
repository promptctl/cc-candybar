// Which placed segments need which data cc-candybar fetches from outside
// itself (brandon-doctor-v62x.onf): the open PR, which a forge CLI answers;
// and the rate-limit windows, which only Claude Code's hook payload carries.
//
// The bar gathers every built-in for every session, so what it fetches says
// nothing about what a segment reads; the doctor asks the config instead. A
// segment needs a source when the payload paths its templates reach, through
// every variable they read, include one the source answers. A placement's own
// `when` is its segment's read; a container's `when` reads data too, but
// belongs to no segment, so the doctor names no data only it needs.

import {
  missingDataOf,
  walkNodes,
  type DslConfig,
} from "../config/dsl-types.js";
import { presetRoot } from "../config/presets.js";
import { declaredVariables } from "../config/loader/refs.js";
import { payloadPathOf, valueReadsOf } from "../config/loader/value-reads.js";
import { PR_FIELDS } from "../daemon/render-payload.js";

export const DATA_SOURCES = ["pullRequests", "rateLimits"] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

const under = (paths: ReadonlySet<string>, prefix: string): boolean =>
  [...paths].some((p) => p === prefix || p.startsWith(`${prefix}.`));

const READS: Readonly<
  Record<DataSource, (paths: ReadonlySet<string>) => boolean>
> = {
  pullRequests: (paths) =>
    Object.keys(PR_FIELDS).some((field) => paths.has(`git.${field}`)),
  rateLimits: (paths) => under(paths, "block") || under(paths, "weekly"),
};

// One segment's own templates. A partial's body is read directly (not
// resolved through its segment's `{{ template "name" }}` dispatch) so a
// payload read inside it is reached whether or not the fold can resolve the
// dispatch name (candybar-templates-zh8b.53s).
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

// The payload paths a set of templates reaches — each input's path, each
// plugin source's name (payloadPathOf) — through every edge of the one fold of
// what a value reads (value-reads.ts): a template's reads and the texts of the
// actions it binds, a variable's template, cache key and depends_on.
function inputClosure(
  config: DslConfig,
  seeds: readonly string[],
): ReadonlySet<string> {
  const reads = valueReadsOf(config);
  const decls = new Map(declaredVariables(config));
  const frontier = seeds.flatMap((template) =>
    reads.ofTemplate(template).flatMap(({ reaches }) => reaches),
  );
  const visited = new Set<string>();
  const inputPaths = new Set<string>();
  while (frontier.length > 0) {
    const name = frontier.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const decl = decls.get(name)!;
    const read = payloadPathOf(name, decl);
    if (read !== undefined) inputPaths.add(read);
    for (const { reaches } of reads.ofVariable(decl)) frontier.push(...reaches);
  }
  return inputPaths;
}

// Per source, the segments of `preset` that read it and count its absence as
// a failure (`missingData`), each named once however often it is placed.
export type DataNeeds = Readonly<Record<DataSource, readonly string[]>>;

export function dataNeeds(config: DslConfig, preset: string): DataNeeds {
  // Each placed segment, with the `when` of every placement of it.
  const placed = new Map<string, string[]>();
  for (const node of walkNodes(presetRoot(config, preset).node)) {
    if (node.kind !== "segment") continue;
    const whens = placed.get(node.name) ?? [];
    if (node.when) whens.push(node.when);
    placed.set(node.name, whens);
  }
  // [LAW:no-defensive-null-guards] cross-ref proved every placed segment is
  // declared.
  const failing = [...placed.keys()].filter(
    (name) => missingDataOf(config.segments[name]!) === "fail",
  );
  const paths = new Map(
    failing.map((name) => [
      name,
      inputClosure(config, [
        ...segmentTemplates(config, name),
        ...placed.get(name)!,
      ]),
    ]),
  );
  const needs = (source: DataSource): readonly string[] =>
    failing.filter((name) => READS[source](paths.get(name)!));
  return {
    pullRequests: needs("pullRequests"),
    rateLimits: needs("rateLimits"),
  };
}
