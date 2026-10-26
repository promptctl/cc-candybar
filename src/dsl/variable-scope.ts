// [LAW:one-source-of-truth] Where each variable of a config lives
// (brandon-unfiled-3248.8ro6, step 2). A value has one home, keyed by its
// scope: a DIRECTORY's store, shared by every session rendering from that
// directory, or a session's VIEW over it. The scope is derived, never
// authored:
//
// - a session's own values — its `input`s (the request's facts), its `state`
//   reads — are the view's;
// - a plugin's `source` is the view's: each session reads its own file;
// - a derivation (`template`, `time`) is the view's: it reads the session's
//   values, the depth its view draws at, and — a projection — the instant of
//   a draw, and only a view is drawn;
// - a value the directory alone decides (`literal`, `env`, a dropped
//   plugin's document) is the directory's;
// - a `shell` or `file` source is the directory's unless its cache policy —
//   the key it re-runs on, or the variables it depends on — reads a view's
//   value, the drawn depth included: then each session runs its own, keyed by
//   its own values, and no session's request re-runs another's. A policy never
//   reads the instant: the loader refuses one that does
//   (src/config/loader/projections.ts), so a directory reads no clock at all.
//
// The command and the path read nothing (plain strings), so a source with a
// `ttl`, `watch_file` or `never` policy runs once per directory.

import { declaredVariables } from "../config/loader/refs.js";
import { valueReadsOf, type ValueReads } from "../config/loader/value-reads.js";
import type { ValidatedConfig, VariableDecl } from "../config/dsl-types.js";
import { DEPTH_FUNCTIONS } from "../template-engine/engine.js";

export type VarScope = "directory" | "view";

// What a source's cache policy reads (value-reads.ts) — the variables whose
// change re-runs it, and a `null` for a read only a view answers: a read of
// nothing declared, or the depth a depth function (`readableOn`) floors at.
function policyReads(
  decl: VariableDecl,
  fold: ValueReads,
): ReadonlyArray<string | null> {
  if (decl.kind !== "shell" && decl.kind !== "file") return [];
  const readsDepth =
    "key" in decl.cache &&
    [...fold.calls(decl.cache.key)].some((name) => DEPTH_FUNCTIONS.has(name));
  return [
    ...fold
      .ofVariable(decl)
      .flatMap(
        ({ reaches }): ReadonlyArray<string | null> =>
          reaches.length === 0 ? [null] : reaches,
      ),
    ...(readsDepth ? [null] : []),
  ];
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
  dropped: "directory",
  // A plugin source is read per session: its reading is the session's own
  // file, which reaches the view through its payload.
  source: "view",
};

// A config's scopes, computed once per config object: every view a session
// opens declares from them.
const SCOPES = new WeakMap<ValidatedConfig, ReadonlyMap<string, VarScope>>();

export function variableScopes(
  config: ValidatedConfig,
): ReadonlyMap<string, VarScope> {
  let scopes = SCOPES.get(config);
  if (scopes === undefined) {
    scopes = scopesOf(config);
    SCOPES.set(config, scopes);
  }
  return scopes;
}

// [LAW:dataflow-not-control-flow] One fold to a fixpoint: a source starts in
// the directory and moves to the view when anything its policy reads is the
// view's — a read of nothing declared included, since only a view could
// answer it — and a source a moved source's policy reads moves it too.
function scopesOf(config: ValidatedConfig): ReadonlyMap<string, VarScope> {
  const declared = new Map(declaredVariables(config));
  const fold = valueReadsOf(config);
  const scopes = new Map<string, VarScope>(
    [...declared].map(([name, decl]) => [
      name,
      decl.kind === "shell" || decl.kind === "file"
        ? "directory"
        : KIND_SCOPE[decl.kind],
    ]),
  );
  const reads = new Map(
    [...declared].map(([name, decl]) => [name, policyReads(decl, fold)]),
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
