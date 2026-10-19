// Which placed segments need which data cc-candybar fetches from outside
// itself (brandon-doctor-v62x.onf): the open PR, which a forge CLI answers;
// the rate-limit windows, which only Claude Code's hook payload carries; and
// memento's context ceiling, which only an installed memento answers.
//
// [LAW:one-source-of-truth] A segment needs a source exactly when the render
// would fetch it for that segment alone: the payload paths it reads come from
// the render's own closure (`segmentInputPaths`), and each source's predicate
// is the gate the payload lane fires on — so the doctor and the bar cannot
// disagree about what a layout reads. A container's `when` reads data too, but
// belongs to no segment, so the doctor names no data only it needs.

import {
  missingDataOf,
  walkNodes,
  type DslConfig,
} from "../config/dsl-types.js";
import { presetRoot } from "../config/presets.js";
import {
  anyPathStartsWith,
  gitOptionsFromClosure,
  segmentInputPaths,
} from "../daemon/render-payload.js";

export const DATA_SOURCES = ["pullRequests", "rateLimits", "memento"] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

const READS: Readonly<
  Record<DataSource, (paths: ReadonlySet<string>) => boolean>
> = {
  pullRequests: (paths) =>
    gitOptionsFromClosure(paths).showPullRequest === true,
  rateLimits: (paths) =>
    anyPathStartsWith(paths, "block") || anyPathStartsWith(paths, "weekly"),
  memento: (paths) => anyPathStartsWith(paths, "memento"),
};

// Per source, the segments of `preset` that read it and count its absence as
// a failure (`missingData`), each named once however often it is placed.
export type DataNeeds = Readonly<Record<DataSource, readonly string[]>>;

export function dataNeeds(config: DslConfig, preset: string): DataNeeds {
  const placed = new Set<string>();
  for (const node of walkNodes(presetRoot(config, preset).node)) {
    if (node.kind === "segment") placed.add(node.name);
  }
  // [LAW:no-defensive-null-guards] cross-ref proved every placed segment is
  // declared.
  const failing = [...placed].filter(
    (name) => missingDataOf(config.segments[name]!) === "fail",
  );
  const paths = new Map(
    failing.map((name) => [name, segmentInputPaths(config, name)]),
  );
  const needs = (source: DataSource): readonly string[] =>
    failing.filter((name) => READS[source](paths.get(name)!));
  return {
    pullRequests: needs("pullRequests"),
    rateLimits: needs("rateLimits"),
    memento: needs("memento"),
  };
}
