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
  type LayoutNode,
  type VariableDecl,
} from "../dsl-types.js";
import {
  actionBindsPersist,
  actionBindsReset,
  actionBindsSet,
  type ActionDecl,
} from "../action.js";
import {
  knownOptionDomainNames,
  perConfigDomainsFor,
} from "../option-domain.js";
import { listGlobalsFieldNames } from "./globals.js";
import { parsePersistTarget } from "./persist-target.js";
import { presetNames } from "../presets.js";
import { findKeyLine } from "./diagnostics.js";
import { isPlainObject, type ValidateCtx } from "./validate-core.js";
import {
  extractActionRefs,
  extractPickerMenuRefs,
  extractTemplateRefs,
  refResolves,
} from "./refs.js";

// [LAW:one-source-of-truth] The renamed built-in segments: old name → current
// name. A user config (which merges on top of the bundled default) that names a
// renamed segment in `root` finds no matching declaration and would otherwise
// get the generic "does not match any declared segment" error. This map turns
// that into a migration pointer [LAW:no-silent-failure] — data, not a per-name
// branch, so a future rename is one row here, not new control flow.
export const RENAMED_SEGMENTS: Readonly<Record<string, string>> = {
  gitTaculous: "gitaculous",
};

export function validateCrossReferences(
  ctx: ValidateCtx,
  cfg: DslConfig,
): void {
  // [LAW:locality-or-seam] globals.look names a member of the MERGED looks
  // block (a user's default may be a bundled look — same reason every cross-ref
  // runs post-merge). Same existence-check shape as layout→segments; an unknown
  // name is a load error, never a silent identity fallback.
  if (
    cfg.globals.look !== undefined &&
    !Object.prototype.hasOwnProperty.call(cfg.looks, cfg.globals.look)
  ) {
    ctx.issues.push({
      path: "globals.look",
      message: `globals.look "${cfg.globals.look}" does not match any declared look (have: ${Object.keys(cfg.looks).join(", ")})`,
      line: findKeyLine(ctx.source, ["globals", "look"]),
    });
  }
  // [LAW:one-type-per-behavior] globals.preset is globals.look one dimension
  // over — the same post-merge membership check against the same kind of
  // per-config block, for the same reason (a user's default may name a
  // bundled preset). A typo'd DEFAULT is a load error even though a stale
  // SESSION pick collapses silently to the floor: the config file is authored
  // and re-readable, so naming a preset that does not exist is a mistake we can
  // point at; a session pick is a click made against a config that has since
  // changed, which is not [LAW:no-silent-failure].
  if (
    cfg.globals.preset !== undefined &&
    !Object.prototype.hasOwnProperty.call(cfg.presets, cfg.globals.preset)
  ) {
    ctx.issues.push({
      path: "globals.preset",
      message: `globals.preset "${cfg.globals.preset}" does not match any declared preset (have: ${Object.keys(cfg.presets).join(", ")})`,
      line: findKeyLine(ctx.source, ["globals", "preset"]),
    });
  }
  // [LAW:one-source-of-truth] A `set … from` NAME must resolve — checked
  // against this config's per-config domains ("looks", the merged looks:
  // block) plus the global registry (themes/styles, and any future
  // registration), the SAME set resolveOptionDomain consults at render and
  // gate-derivation time. An inline array `from` is its own domain — nothing
  // to resolve. Runs post-merge for the same reason globals.look does above:
  // "looks" isn't fully known until the user's looks: block has merged onto
  // the bundled stdlib.
  const optionDomains = perConfigDomainsFor(cfg);
  for (const [name, a] of Object.entries(cfg.actions)) {
    if (!("set" in a) || !("from" in a) || typeof a.from !== "string") continue;
    if (!knownOptionDomainNames(optionDomains).includes(a.from)) {
      ctx.issues.push({
        path: `actions.${name}.from`,
        message: `actions.${name} from: references unknown option domain "${a.from}" (have: ${knownOptionDomainNames(optionDomains).join(", ")})`,
        line: findKeyLine(ctx.source, ["actions", name, "from"]),
      });
    }
  }
  // [LAW:no-silent-failure] A `persist`/`reset` target must name a REAL
  // Globals field OR a declared segment's `palette` (candybar-config-engine-
  // 71o.6 — `segments.<name>.palette`, parsed by the one shared authority in
  // persist-target.ts) — the loader's structural pass (loader/actions.ts)
  // only proves the key is non-empty/slash-free, the same shape a `set` key
  // needs for the wire, but a persist/reset key additionally has to land
  // somewhere real. Catching a typo (`persist: "pallete"`) or a dangling
  // segment name here turns a confusing click-time "registration invariant
  // broken" error into a clear load-time one naming the actual allowed
  // targets — the same species of fix as the `from` domain check just above.
  for (const [name, a] of Object.entries(cfg.actions)) {
    const key = "persist" in a ? a.persist : "reset" in a ? a.reset : null;
    if (key === null) continue;
    const discriminator = "persist" in a ? "persist" : "reset";
    const target = parsePersistTarget(key);
    if (target === null) {
      ctx.issues.push({
        path: `actions.${name}.${discriminator}`,
        message: `actions.${name}: "${key}" is not a config globals field (have: ${listGlobalsFieldNames().join(", ")}), a "segments.<name>.palette" target, or a "presets.<name>.rootOps" target`,
        line: findKeyLine(ctx.source, ["actions", name, discriminator]),
      });
      continue;
    }
    if (target.scope === "preset-root-ops") {
      checkPresetRootOpsTarget(
        ctx,
        cfg,
        name,
        discriminator,
        key,
        target.preset,
        a,
      );
      continue;
    }
    if (target.scope !== "segment-palette") continue;
    if (!Object.prototype.hasOwnProperty.call(cfg.segments, target.segment)) {
      ctx.issues.push({
        path: `actions.${name}.${discriminator}`,
        message: `actions.${name}: "${key}" names segment "${target.segment}" which is not declared (have segments: ${Object.keys(cfg.segments).join(", ")})`,
        line: findKeyLine(ctx.source, ["actions", name, discriminator]),
      });
      continue;
    }
    // [LAW:types-are-the-program] A palette is a NAME, not a number — a
    // bounded stepper (`min`/`max`/`by`) has no meaning over it, unlike a
    // Globals field where nothing today enforces value/field-kind agreement
    // either way. Rejecting it here (rather than tolerating a numeric-string
    // palette name that only fails later at `paletteForThemeName`) keeps
    // the failure at load time, next to the typo it actually is.
    if ("min" in a) {
      ctx.issues.push({
        path: `actions.${name}.${discriminator}`,
        message: `actions.${name}: "${key}" is a segment palette target and cannot use a bounded stepper (min/max/by) — use "to", "from", or "cycle" instead`,
        line: findKeyLine(ctx.source, ["actions", name, discriminator]),
      });
    }
  }
  // [LAW:one-source-of-truth] THE set of resolvable variable names — a
  // faithful mirror of the runtime store's key set (declareOne in
  // src/dsl/render.ts registers globals under their bare names and segment
  // locals under segName.varName, nothing else). The runtime scope proxy
  // (src/template-engine/scope.ts) resolves only keys literally present in
  // the store, and the depends_on reaction (src/var-system/sources.ts) calls
  // store.read with each listed name verbatim — so exactly the names in this
  // set exist at runtime. One set for every reference surface, template refs
  // and depends_on lists alike: a name's meaning is a pure function of the
  // name string, never of which segment declares or renders it.
  const templateScope = new Set<string>(Object.keys(cfg.variables));
  for (const [segName, seg] of Object.entries(cfg.segments)) {
    if (!seg.vars) continue;
    for (const v of Object.keys(seg.vars)) templateScope.add(`${segName}.${v}`);
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
  //
  // [LAW:one-type-per-behavior] A PRESET's `root` is a root: it gets this exact
  // walk, not a reduced copy. The only thing that varies between the config's
  // own tree and a preset's is the diagnostic key + line — data threaded in,
  // never a second traversal that could learn a different idea of what a valid
  // layout is. This is what makes `cc-candybar check` catch a preset staging a
  // segment nobody declared.
  const checkLayoutTree = (
    root: LayoutNode,
    layoutKey: string,
    layoutLine: number | undefined,
  ): void => {
    for (const node of walkNodes(root)) {
      // [LAW:locality-or-seam] A node's `when` reads the global scope (bare
      // globals + namespaced segment vars) — the same existence-check shape as a
      // segment template, surfaced at load time.
      if (node.when !== undefined) {
        checkTemplateRefs(ctx, `${layoutKey}.when`, node.when, templateScope, {
          line: layoutLine,
        });
      }
      if (node.kind !== "segment") continue;
      if (!Object.prototype.hasOwnProperty.call(cfg.segments, node.name)) {
        const renamed = RENAMED_SEGMENTS[node.name];
        const hint =
          renamed !== undefined
            ? ` (the built-in segment "${node.name}" was renamed to "${renamed}" — update this reference)`
            : "";
        ctx.issues.push({
          path: layoutKey,
          message: `${layoutKey} entry "${node.name}" does not match any declared segment${hint}`,
          line: layoutLine,
        });
      }
    }
  };
  const layoutKey = authoredLayoutKey(ctx.source);
  checkLayoutTree(cfg.root, layoutKey, findKeyLine(ctx.source, [layoutKey]));
  for (const [name, preset] of Object.entries(cfg.presets)) {
    if (preset.root === undefined) continue;
    checkLayoutTree(
      preset.root,
      `presets.${name}.root`,
      findKeyLine(ctx.source, ["presets", name, "root"]),
    );
  }

  // For each variable's template/cache.key, every dotted ref must exist
  // (full path OR a prefix that matches an existing variable's namespace).
  for (const [name, v] of Object.entries(cfg.variables)) {
    checkVarRefs(ctx, `variables.${name}`, v, templateScope);
  }

  for (const [segName, seg] of Object.entries(cfg.segments)) {
    // [LAW:one-source-of-truth] Segment templates check against the SAME
    // templateScope as everything else — segment locals resolve via the
    // namespaced segName.varName form only, exactly as the runtime store
    // keys them. The segment name is passed purely as a diagnostic hint: a
    // bare ref to an own local is rejected with a message naming the
    // namespaced form the author should write.
    if (seg.vars) {
      for (const [vName, vDecl] of Object.entries(seg.vars)) {
        checkVarRefs(
          ctx,
          `segments.${segName}.vars.${vName}`,
          vDecl,
          templateScope,
          segName,
        );
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
      checkTemplateRefs(
        ctx,
        `segments.${segName}.${field}`,
        tpl,
        templateScope,
        {
          segCtx: segName,
        },
      );
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
      // [LAW:locality-or-seam] A `{{ picker "apply" "page" … }}` OR `{{ menu
      // "apply" "page" … }}` references two named actions — both resolve against
      // the action table at load, same existence-check shape as a bare action ref.
      // A menu binds the same pair as a picker, so it routes through the SAME
      // check rather than failing only when the disclosure is opened.
      for (const pref of extractPickerMenuRefs(tpl)) {
        if (!Object.prototype.hasOwnProperty.call(cfg.actions, pref)) {
          ctx.issues.push({
            path: `segments.${segName}.${field}`,
            message: `${field} references unknown action "${pref}" (in a picker or menu)`,
            line: findKeyLine(ctx.source, ["segments", segName, field]),
          });
        }
      }
    }
  }

  // depends_on lists must point at declared variables — checked against the
  // SAME templateScope as template refs, since both resolve against the one
  // runtime store. The segment name is a diagnostic hint only, never a
  // resolution rule, exactly as for templates.
  for (const [name, v] of Object.entries(cfg.variables)) {
    checkDependsOn(ctx, `variables.${name}`, v, templateScope);
  }
  for (const [segName, seg] of Object.entries(cfg.segments)) {
    if (!seg.vars) continue;
    for (const [vName, vDecl] of Object.entries(seg.vars)) {
      checkDependsOn(
        ctx,
        `segments.${segName}.vars.${vName}`,
        vDecl,
        templateScope,
        segName,
      );
    }
  }

  // [LAW:verifiable-goals] state-kind variables have an implicit dependency
  // on the canonical session-id input variable. Same shape as the
  // depends_on / template-ref existence checks above — surface a missing
  // anchor at load time so the user fixes the config from a config-file
  // error message, not from a render-time ReferenceError.
  //
  // [LAW:types-are-the-program] Check against `cfg.variables` directly: the
  // accept/reject table for this predicate is "GLOBAL session.id declared".
  // A segment-local declaration named "session.id" registers at runtime as
  // `<seg>.session.id` and does NOT satisfy declareState's read of the
  // global `session.id` box.
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

// [LAW:no-silent-failure] brandon-layout-edit-2gc.1's structural-edit target
// check, one arm of the persist/reset key cross-ref above. Three things must
// hold at load time, same spirit as the segment-palette check just above it:
// the preset name must be real (mirrors globals.preset's check earlier in
// this function), the arm pairing must make sense for this scope (only
// removeSegment/insertSegment address a tree — a `to`/`from`/cycle/bounded
// literal has no meaning as "the current op log"), and every segment name
// the op names must be declared.
function checkPresetRootOpsTarget(
  ctx: ValidateCtx,
  cfg: DslConfig,
  name: string,
  discriminator: "persist" | "reset",
  key: string,
  presetName: string,
  a: ActionDecl,
): void {
  const at = `actions.${name}.${discriminator}`;
  const line = findKeyLine(ctx.source, ["actions", name, discriminator]);
  if (!presetNames(cfg.presets).includes(presetName)) {
    ctx.issues.push({
      path: at,
      message: `actions.${name}: "${key}" names preset "${presetName}" which is not declared (have: ${presetNames(cfg.presets).join(", ")})`,
      line,
    });
    return;
  }
  // [LAW:one-source-of-truth] `reset` has no value-source arm to check — its
  // shape is a bare `{ reset: key }` — so the arm-pairing/segment checks
  // below are `persist`-only, exactly as the "reset" action's clean-slate
  // undo is meant to be: it clears the whole op log regardless of what wrote
  // it.
  if (discriminator === "reset") return;
  const hasRemove = "removeSegment" in a;
  const hasInsert = "insertSegment" in a;
  if (!hasRemove && !hasInsert) {
    ctx.issues.push({
      path: at,
      message: `actions.${name}: "${key}" is a "presets.<name>.rootOps" target and can only be paired with "removeSegment" or "insertSegment" (not "to"/"from"/"cycle"/bounded — those have no meaning as a tree op)`,
      line,
    });
    return;
  }
  const missing = (segName: string): boolean =>
    !Object.prototype.hasOwnProperty.call(cfg.segments, segName);
  if (hasRemove && "removeSegment" in a && missing(a.removeSegment)) {
    ctx.issues.push({
      path: at,
      message: `actions.${name}: removeSegment "${a.removeSegment}" is not a declared segment (have: ${Object.keys(cfg.segments).join(", ")})`,
      line,
    });
  }
  if (hasInsert && "insertSegment" in a) {
    if (missing(a.insertSegment)) {
      ctx.issues.push({
        path: at,
        message: `actions.${name}: insertSegment "${a.insertSegment}" is not a declared segment (have: ${Object.keys(cfg.segments).join(", ")})`,
        line,
      });
    }
    if (missing(a.anchor)) {
      ctx.issues.push({
        path: at,
        message: `actions.${name}: anchor "${a.anchor}" is not a declared segment (have: ${Object.keys(cfg.segments).join(", ")})`,
        line,
      });
    }
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

// [LAW:dataflow-not-control-flow] A config emits a set-state, set-config, OR
// reset-config click — and so needs session.id — when any declared action is
// a `set` (literal/option/bounded/cycle), a `persist` (its config-overrides
// twin), or a `reset` (persist's gated undo) — all three carry session.id on
// the wire for click-error surfacing. copy/open actions write nothing, so
// they embed no session.id.
function hasActionSetAction(cfg: DslConfig): boolean {
  return Object.values(cfg.actions).some(
    (a) => actionBindsSet(a) || actionBindsPersist(a) || actionBindsReset(a),
  );
}

function checkVarRefs(
  ctx: ValidateCtx,
  declPath: string,
  v: VariableDecl,
  allVars: Set<string>,
  segCtx?: string,
): void {
  if (v.kind === "template") {
    checkTemplateRefs(ctx, `${declPath}.template`, v.template, allVars, {
      segCtx,
    });
  }
  if (hasCacheField(v)) {
    if (v.cache && "key" in v.cache) {
      checkTemplateRefs(ctx, `${declPath}.cache.key`, v.cache.key, allVars, {
        segCtx,
      });
    }
  }
}

function checkDependsOn(
  ctx: ValidateCtx,
  declPath: string,
  v: VariableDecl,
  allVars: Set<string>,
  segCtx?: string,
): void {
  if (!hasCacheField(v)) return;
  if (!v.cache) return;
  if (!("depends_on" in v.cache)) return;
  for (let i = 0; i < v.cache.depends_on.length; i++) {
    const target = v.cache.depends_on[i]!;
    // [LAW:one-source-of-truth] Exact membership, not refResolves: the
    // depends_on reaction calls store.read(name) with each listed name
    // verbatim, and the store is an exact-key map. A dotted prefix that
    // merely navigates INTO a value (resolvable in a template) is not a
    // store key and would throw at runtime.
    if (allVars.has(target)) continue;
    const namespaced = segCtx !== undefined ? `${segCtx}.${target}` : undefined;
    const hint =
      namespaced !== undefined && allVars.has(namespaced)
        ? ` (segment-local vars are namespaced — write "${namespaced}")`
        : "";
    ctx.issues.push({
      path: `${declPath}.cache.depends_on[${i}]`,
      message: `cache.depends_on references unknown variable "${target}"${hint}`,
      line: findKeyLine(ctx.source, [
        ...declPath.split("."),
        "cache",
        "depends_on",
      ]),
    });
  }
}

function checkTemplateRefs(
  ctx: ValidateCtx,
  declPath: string,
  template: string,
  allVars: Set<string>,
  opts?: {
    // [LAW:one-source-of-truth] Callers whose `declPath` is not a literal key
    // path into the source (a node `when`, whose canonical tree position no
    // longer maps to a source key after the layout/root merge) pass the
    // already-resolved line explicitly. Absent, the line is derived from the
    // dotted declPath as before.
    line?: number;
    // The segment whose template is being checked — a diagnostic hint only,
    // never a resolution rule. When a failing bare ref would resolve under
    // this segment's namespace, the message names the namespaced form.
    segCtx?: string;
  },
): void {
  for (const ref of extractTemplateRefs(template)) {
    if (refResolves(ref, allVars)) continue;
    const namespaced =
      opts?.segCtx !== undefined ? `${opts.segCtx}.${ref}` : undefined;
    const hint =
      namespaced !== undefined && refResolves(namespaced, allVars)
        ? ` (segment-local vars are namespaced — write ".${namespaced}")`
        : "";
    ctx.issues.push({
      path: declPath,
      message: `Template references unknown variable ".${ref}"${hint}`,
      line: opts?.line ?? findKeyLine(ctx.source, declPath.split(".")),
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
