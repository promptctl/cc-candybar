// [LAW:one-source-of-truth] Where each variable of a config lives
// (brandon-unfiled-3248.8ro6, step 2). A value has one home, keyed by its
// scope: a DIRECTORY's store, shared by every session rendering from that
// directory, or a session's VIEW over it. The scope is derived, never
// authored:
//
// - a session's own values — its `input`s (the request's facts), its `state`
//   reads — are the view's;
// - a derivation (`template`, `time`) is the view's: it reads the session's
//   values and the render's instant and depth, which only a view has;
// - a value the directory alone decides (`literal`, `env`, `git`, a dropped
//   plugin's document) is the directory's;
// - a `shell` or `file` source is the directory's unless its cache policy —
//   the key it re-runs on, or the variables it depends on — reads a view's
//   value: then each session runs its own, keyed by its own values, and no
//   session's request re-runs another's.
//
// The command and the path read nothing (plain strings), so a source with a
// `ttl`, `watch_file` or `never` policy runs once per directory.

import { templateReads } from "../config/loader/refs.js";
import type { ValidatedConfig, VariableDecl } from "../config/dsl-types.js";

export type VarScope = "directory" | "view";

// Every variable the config declares, under the name the store holds it by:
// a global by its own name, a segment's local as `segName.varName`.
export function* declaredVariables(
  config: ValidatedConfig,
): IterableIterator<readonly [name: string, decl: VariableDecl]> {
  yield* Object.entries(config.variables);
  for (const [segName, seg] of Object.entries(config.segments)) {
    for (const [varName, decl] of Object.entries(seg.vars ?? {})) {
      yield [`${segName}.${varName}`, decl];
    }
  }
}

// The variable a dotted read lands on: the longest declared name the path
// starts with (`.budget.spent` reads the document `budget`). Null for a read
// of nothing declared.
function variableRead(path: string, names: ReadonlySet<string>): string | null {
  const parts = path.split(".");
  for (let n = parts.length; n > 0; n--) {
    const name = parts.slice(0, n).join(".");
    if (names.has(name)) return name;
  }
  return null;
}

// What a source's cache policy reads — the variables whose change re-runs it.
function policyReads(
  decl: VariableDecl,
  names: ReadonlySet<string>,
  helpers: Readonly<Record<string, string>>,
): ReadonlyArray<string | null> {
  if (decl.kind !== "shell" && decl.kind !== "file") return [];
  const { cache } = decl;
  if ("depends_on" in cache) return cache.depends_on;
  if ("key" in cache) {
    return [...templateReads(cache.key, helpers).keys()].map((path) =>
      variableRead(path, names),
    );
  }
  return [];
}

const KIND_SCOPE: Readonly<
  Record<Exclude<VariableDecl["kind"], "shell" | "file">, VarScope>
> = {
  input: "view",
  state: "view",
  template: "view",
  time: "view",
  literal: "directory",
  env: "directory",
  git: "directory",
  dropped: "directory",
};

// [LAW:dataflow-not-control-flow] One fold to a fixpoint: a source starts in
// the directory and moves to the view when anything its policy reads is the
// view's — a read of nothing declared included, since only a view could
// answer it — and a source a moved source's policy reads moves it too.
export function variableScopes(
  config: ValidatedConfig,
): ReadonlyMap<string, VarScope> {
  const declared = new Map(declaredVariables(config));
  const names = new Set(declared.keys());
  const scopes = new Map<string, VarScope>(
    [...declared].map(([name, decl]) => [
      name,
      decl.kind === "shell" || decl.kind === "file"
        ? "directory"
        : KIND_SCOPE[decl.kind],
    ]),
  );
  const reads = new Map(
    [...declared].map(([name, decl]) => [
      name,
      policyReads(decl, names, config.helpers),
    ]),
  );
  for (let moved = true; moved; ) {
    moved = false;
    for (const [name, read] of reads) {
      if (scopes.get(name) === "view") continue;
      if (read.some((r) => r === null || scopes.get(r) !== "directory")) {
        scopes.set(name, "view");
        moved = true;
      }
    }
  }
  return scopes;
}
