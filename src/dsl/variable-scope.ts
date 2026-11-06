// [LAW:one-source-of-truth] Where each variable of a config lives
// (brandon-unfiled-3248.8ro6, step 2). A value has one home, keyed by its
// scope: a DIRECTORY's store, shared by every session rendering from that
// directory, or a session's VIEW over it. The scope is derived from the
// variable's kind, never authored:
//
// - a session's own values — its `input`s (the request's facts), its `state`
//   reads — are the view's;
// - a plugin's `source` is the view's: each session reads its own file;
// - a `shell` or `file` source is the view's: what it read reaches a session
//   through the session's facts document (src/daemon/facts-source.ts), which
//   a node every session shares could not read. One run serves every view
//   declaring its identity, so a source runs once however many sessions draw
//   it: what one run serves is its digest's to decide
//   (src/var-system/source-runs.ts), not its scope's;
// - a derivation (`template`, `time`) is the view's: it reads the session's
//   values, the depth its view draws at, and — a projection — the instant of
//   a draw, and only a view is drawn;
// - a value the directory alone decides (`literal`, a dropped
//   plugin's document) is the directory's.

import { declaredVariables } from "../config/loader/refs.js";
import type { ValidatedConfig, VariableDecl } from "../config/dsl-types.js";

export type VarScope = "directory" | "view";

const KIND_SCOPE: Readonly<Record<VariableDecl["kind"], VarScope>> = {
  input: "view",
  state: "view",
  template: "view",
  time: "view",
  shell: "view",
  file: "view",
  literal: "directory",
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
    scopes = new Map(
      [...declaredVariables(config)].map(([name, decl]) => [
        name,
        KIND_SCOPE[decl.kind],
      ]),
    );
    SCOPES.set(config, scopes);
  }
  return scopes;
}
