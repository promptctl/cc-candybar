// [LAW:one-source-of-truth] Where each variable of a config lives
// (brandon-unfiled-3248.8ro6, step 2). A value has one home, keyed by its
// scope: a DIRECTORY's store, shared by every session rendering from that
// directory, or a session's VIEW over it. The scope is derived from the
// variable's kind, never authored:
//
// - a session's own values — its `input`s (the request's facts), its `state`
//   reads — are the view's;
// - a source whose reading arrives in the session's world state — a plugin's
//   `source`, a `shell` or `file` run — is the view's: a directory has no
//   session to read a world state from. Sessions of one directory still share
//   a run, because they name one digest and the host keys runs by digest
//   (docs/design/per-directory-sources.md);
// - a derivation (`template`, `time`) is the view's: it reads the session's
//   values, the depth its view draws at, and — a projection — the instant of
//   a draw, and only a view is drawn;
// - a value the directory alone decides (`literal`, `env`, a dropped
//   plugin's document) is the directory's.

import { declaredVariables } from "../config/loader/refs.js";
import type { ValidatedConfig, VariableDecl } from "../config/dsl-types.js";

export type VarScope = "directory" | "view";

const KIND_SCOPE: Readonly<Record<VariableDecl["kind"], VarScope>> = {
  input: "view",
  state: "view",
  template: "view",
  time: "view",
  source: "view",
  shell: "view",
  file: "view",
  literal: "directory",
  env: "directory",
  dropped: "directory",
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
