// [LAW:single-enforcer] All cross-reference resolution on the MERGED config:
// layout nodes name declared segments, every template-bearing field references
// only existing variables/actions, depends_on points at declared variables, and
// state/set-action configs declare the session.id anchor. Runs after merge so a
// user surface can reference default-provided segments/actions. This file changes
// when the visibility/scoping rules between config parts change.

import JSON5 from "json5";
import {
  hasCacheField,
  walkNodes,
  type DslConfig,
  type VariableDecl,
} from "../dsl-types.js";
import { actionBindsSet } from "../action.js";
import { findKeyLine } from "./diagnostics.js";
import { isPlainObject, type ValidateCtx } from "./validate-core.js";
import {
  extractActionRefs,
  extractPickerRefs,
  extractTemplateRefs,
  refResolves,
} from "./refs.js";

export function validateCrossReferences(
  ctx: ValidateCtx,
  cfg: DslConfig,
): void {
  // Full set for depends_on validation (all names, bare + namespaced). depends_on
  // takes explicit fully-qualified names, so cross-segment visibility is intentional.
  const allVarNames = new Set<string>(Object.keys(cfg.variables));
  for (const [segName, seg] of Object.entries(cfg.segments)) {
    if (seg.vars) {
      for (const v of Object.keys(seg.vars)) allVarNames.add(v);
      for (const v of Object.keys(seg.vars)) allVarNames.add(`${segName}.${v}`);
    }
  }

  // [LAW:single-enforcer] ONE pre-order walk over the canonical node tree owns
  // every layout cross-ref: each cells node's segment names must resolve to a
  // declared segment, and any node's `when` predicate (a template like any
  // other) must reference only existing variables. Cross-ref runs on the MERGED
  // config so a node can name default-provided segments without re-declaring
  // them. It traverses the canonical tree — the raw `layout`-vs-`root` authoring
  // form is already collapsed and unrecoverable post-merge — so the path
  // describes the tree and `line` points at whichever layout key the user wrote.
  // [LAW:one-source-of-truth] Which top-level layout surface the user authored
  // is read from the PARSED structure, not a text probe: a nested key named
  // `root` (a variable, a segment) — or `layout` (a `time` var's `layout`
  // field) — would fool a raw `findKeyLine` search and misclassify the config.
  // Validation is cold-path, so reading the source's top-level keys is exact.
  // The reported path/message then point at the surface the user wrote.
  const layoutKey = authoredLayoutKey(ctx.source);
  const layoutLine = findKeyLine(ctx.source, [layoutKey]);
  for (const node of walkNodes(cfg.root)) {
    // [LAW:locality-or-seam] A node's `when` reads the global scope (bare
    // globals + namespaced segment vars) — the same existence-check shape as a
    // segment template, surfaced at load time.
    if (node.when !== undefined) {
      checkTemplateRefs(
        ctx,
        `${layoutKey}.when`,
        node.when,
        allVarNames,
        layoutLine,
      );
    }
    if (node.kind !== "segment") continue;
    if (!Object.prototype.hasOwnProperty.call(cfg.segments, node.name)) {
      ctx.issues.push({
        path: layoutKey,
        message: `${layoutKey} entry "${node.name}" does not match any declared segment`,
        line: layoutLine,
      });
    }
  }

  // For each variable's template/cache.key, every dotted ref must exist
  // (full path OR a prefix that matches an existing variable's namespace).
  for (const [name, v] of Object.entries(cfg.variables)) {
    checkVarRefs(ctx, `variables.${name}`, v, allVarNames);
  }

  for (const [segName, seg] of Object.entries(cfg.segments)) {
    // [LAW:single-enforcer] Per-segment scope: global vars + this segment's
    // locals (bare + namespaced) + other segments' vars (namespaced ONLY).
    // Matches runtime scope-proxy rules: own locals visible by bare name;
    // cross-segment refs require the qualified segName.varName form.
    const segScope = new Set<string>(Object.keys(cfg.variables));
    for (const [otherSeg, otherSegDecl] of Object.entries(cfg.segments)) {
      if (!otherSegDecl.vars) continue;
      for (const vName of Object.keys(otherSegDecl.vars)) {
        if (otherSeg === segName) segScope.add(vName); // own: bare form
        segScope.add(`${otherSeg}.${vName}`); // all: namespaced form
      }
    }

    if (seg.vars) {
      for (const [vName, vDecl] of Object.entries(seg.vars)) {
        checkVarRefs(ctx, `segments.${segName}.vars.${vName}`, vDecl, segScope);
      }
    }
    // [LAW:locality-or-seam] Variable refs AND `{{ action }}`/`{{ picker }}` refs
    // are checked across EVERY template-bearing field, not just `template` —
    // bg/fg/when are templates too, so an unknown ref in them is a load error, not
    // a render-time surprise. Same existence-check shape as layout→segments; runs
    // on the merged config so a segment can reference a default-provided action.
    for (const field of ["template", "bg", "fg", "when"] as const) {
      const tpl = seg[field];
      if (typeof tpl !== "string") continue;
      checkTemplateRefs(ctx, `segments.${segName}.${field}`, tpl, segScope);
      // [LAW:locality-or-seam] `{{ action "name" … }}` refs resolve against the
      // action table on the merged config so a segment can reference a
      // default-provided action.
      for (const aref of extractActionRefs(tpl)) {
        if (!Object.prototype.hasOwnProperty.call(cfg.actions, aref)) {
          ctx.issues.push({
            path: `segments.${segName}.${field}`,
            message: `${field} references unknown action "${aref}"`,
            line: findKeyLine(ctx.source, ["segments", segName, field]),
          });
        }
      }
      // [LAW:locality-or-seam] A `{{ picker "apply" "page" … }}` references two
      // named actions — both resolve against the action table at load, same
      // existence-check shape as a bare action ref.
      for (const pref of extractPickerRefs(tpl)) {
        if (!Object.prototype.hasOwnProperty.call(cfg.actions, pref)) {
          ctx.issues.push({
            path: `segments.${segName}.${field}`,
            message: `${field} references unknown action "${pref}" (in a picker)`,
            line: findKeyLine(ctx.source, ["segments", segName, field]),
          });
        }
      }
    }
  }

  // depends_on lists must point at declared variables.
  for (const [name, v] of Object.entries(cfg.variables)) {
    checkDependsOn(ctx, `variables.${name}`, v, allVarNames);
  }
  for (const [segName, seg] of Object.entries(cfg.segments)) {
    if (!seg.vars) continue;
    for (const [vName, vDecl] of Object.entries(seg.vars)) {
      checkDependsOn(
        ctx,
        `segments.${segName}.vars.${vName}`,
        vDecl,
        allVarNames,
      );
    }
  }

  // [LAW:verifiable-goals] state-kind variables have an implicit dependency
  // on the canonical session-id input variable. Same shape as the
  // depends_on / template-ref existence checks above — surface a missing
  // anchor at load time so the user fixes the config from a config-file
  // error message, not from a render-time ReferenceError.
  //
  // [LAW:types-are-the-program] Check against `cfg.variables` directly, not
  // `allVarNames`: a segment-local declaration named "session.id" registers
  // at runtime as `<seg>.session.id` and does NOT satisfy declareState's
  // read of the global `session.id` box. The accept/reject table for this
  // predicate is "GLOBAL session.id declared" — `allVarNames` (which
  // includes bare segment-local names by construction, for depends_on
  // scope) is the wrong set.
  // [LAW:verifiable-goals] A widget `set` action composes a set-state click URL
  // whose first segment is `session.id` (read from the store at render). Without
  // a global session.id the URL is malformed and the daemon rejects the click
  // (requireSessionId is the single enforcer — it rejects empty/slash session
  // ids loudly, so there is no silent corruption; this surfaces the SAME
  // requirement at load instead of at first click). Same anchor + same shape as
  // the state-kind requirement above; OR them so either trigger fires it once.
  // [LAW:dataflow-not-control-flow] A `set` action composes a set-state click URL
  // whose first segment is session.id. OR it into the same requirement so an
  // actions-only config (no state vars) still demands the anchor it needs. A
  // picker's ✕/←/→/apply-close all go through `set` actions, so this covers them.
  if (
    (hasStateKind(cfg) || hasActionSetAction(cfg)) &&
    !Object.prototype.hasOwnProperty.call(cfg.variables, "session.id")
  ) {
    ctx.issues.push({
      path: "variables.session.id",
      message: `state reads and action set-writes require a global "session.id" variable (segment-local declarations do not satisfy this — declareState/set-state both read the global box; conventionally { kind: "input", path: "session_id" })`,
      line: findKeyLine(ctx.source, ["variables"]),
    });
  }
}

function hasStateKind(cfg: DslConfig): boolean {
  for (const v of Object.values(cfg.variables)) {
    if (v.kind === "state") return true;
  }
  for (const seg of Object.values(cfg.segments)) {
    if (!seg.vars) continue;
    for (const v of Object.values(seg.vars)) {
      if (v.kind === "state") return true;
    }
  }
  return false;
}

// [LAW:dataflow-not-control-flow] A config emits a set-state click — and so needs
// session.id — when any declared action is a `set` (literal, option, or bounded).
// copy/open actions write nothing, so they embed no session.id.
function hasActionSetAction(cfg: DslConfig): boolean {
  return Object.values(cfg.actions).some(actionBindsSet);
}

function checkVarRefs(
  ctx: ValidateCtx,
  declPath: string,
  v: VariableDecl,
  allVars: Set<string>,
): void {
  if (v.kind === "template") {
    checkTemplateRefs(ctx, `${declPath}.template`, v.template, allVars);
  }
  if (hasCacheField(v)) {
    if (v.cache && "key" in v.cache) {
      checkTemplateRefs(ctx, `${declPath}.cache.key`, v.cache.key, allVars);
    }
  }
}

function checkDependsOn(
  ctx: ValidateCtx,
  declPath: string,
  v: VariableDecl,
  allVars: Set<string>,
): void {
  if (!hasCacheField(v)) return;
  if (!v.cache) return;
  if (!("depends_on" in v.cache)) return;
  for (let i = 0; i < v.cache.depends_on.length; i++) {
    const target = v.cache.depends_on[i]!;
    if (!allVars.has(target)) {
      ctx.issues.push({
        path: `${declPath}.cache.depends_on[${i}]`,
        message: `cache.depends_on references unknown variable "${target}"`,
        line: findKeyLine(ctx.source, [
          ...declPath.split("."),
          "cache",
          "depends_on",
        ]),
      });
    }
  }
}

function checkTemplateRefs(
  ctx: ValidateCtx,
  declPath: string,
  template: string,
  allVars: Set<string>,
  // [LAW:one-source-of-truth] Callers whose `declPath` is not a literal key path
  // into the source (a node `when`, whose canonical tree position no longer maps
  // to a source key after the layout/root merge) pass the already-resolved line
  // explicitly. Absent, the line is derived from the dotted declPath as before.
  line?: number,
): void {
  for (const ref of extractTemplateRefs(template)) {
    if (refResolves(ref, allVars)) continue;
    ctx.issues.push({
      path: declPath,
      message: `Template references unknown variable ".${ref}"`,
      line: line ?? findKeyLine(ctx.source, declPath.split(".")),
    });
  }
}

// [LAW:one-source-of-truth] The authored top-level layout surface, read from the
// PARSED top-level keys (`root` wins; the loader already rejects authoring both).
// A structural read — not a text search — so a nested key named `root`/`layout`
// can never misclassify the config. Empty/unparseable source (the bundled
// default, no file) has no surface; defaults to the historical `layout` label.
function authoredLayoutKey(source: string): "root" | "layout" {
  try {
    const parsed = JSON5.parse(source);
    if (isPlainObject(parsed) && "root" in parsed) return "root";
  } catch {
    // No source to read (default config) or unparseable — fall through. A real
    // syntax error is already reported by parseDslConfig before cross-ref runs.
  }
  return "layout";
}
