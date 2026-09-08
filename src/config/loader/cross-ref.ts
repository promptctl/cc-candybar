// [LAW:single-enforcer] All cross-reference resolution runs on the MERGED config.

import JSON5 from "json5";
import {
  hasCacheField,
  walkNodes,
  type DslConfig,
  type LayoutNode,
  type PresetDecl,
  type VariableDecl,
  parseArm,
} from "../dsl-types.js";
import {
  actionBindsPersist,
  actionBindsRedo,
  actionBindsReset,
  actionBindsDoctor,
  actionBindsSet,
  actionIsDual,
  PERSIST_WHEN,
  actionBindsUndo,
  type ActionDecl,
} from "../action.js";
import {
  knownOptionDomainNames,
  perConfigDomainsFor,
} from "../option-domain.js";
import { listGlobalsFieldNames } from "./globals.js";
import { parsePersistTarget } from "./persist-target.js";
import { presetNames, presetRoot } from "../presets.js";
import { fragmentNode, rootNode } from "../root.js";
import { segmentReferencesMenu } from "./menu-synth.js";
import {
  canHostSessionState,
  countAnchors,
  isSettingsAnchor,
  SESSION_ID_VAR,
  SETTINGS_ANCHOR,
} from "../settings-menu.js";
import { ident } from "../ident.js";
import { findKeyLine } from "./diagnostics.js";
import { isPlainObject, type ValidateCtx } from "./validate-core.js";
import {
  extractActionRefs,
  extractPickerMenuRefs,
  extractTemplateRefs,
  refResolves,
  type TemplateScope,
} from "./refs.js";

// [LAW:one-source-of-truth] Renamed built-ins, so a stale reference gets a migration pointer.
export const RENAMED_SEGMENTS: Readonly<Record<string, string>> = {
  gitTaculous: "gitaculous",
};

// [LAW:no-silent-failure] Two preset names collapsing to one `ident` would make edit mode's
// synthesized artifacts steal each other's; only this pass sees the merged set.
function presetIdentCollisions(
  ctx: ValidateCtx,
  presets: Readonly<Record<string, PresetDecl>>,
): void {
  const byIdent = new Map<string, string[]>();
  for (const name of Object.keys(presets)) {
    const id = ident(name);
    const names = byIdent.get(id);
    if (names) names.push(name);
    else byIdent.set(id, [name]);
  }
  for (const [id, names] of byIdent) {
    if (names.length < 2) continue;
    ctx.issues.push({
      path: "presets",
      message: `preset names ${names.map((n) => JSON.stringify(n)).join(" and ")} both collapse to the same synthesis identifier "${id}" — edit mode's synthesized reset affordance would silently steal one preset's action for the other. Rename one.`,
      line: findKeyLine(ctx.source, ["presets"]),
    });
  }
}

export function validateCrossReferences(
  ctx: ValidateCtx,
  cfg: DslConfig,
): void {
  // [LAW:locality-or-seam] An unknown look name is a load error, never a silent fallback.
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
  // [LAW:one-type-per-behavior] The same membership check one dimension over.
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
  presetIdentCollisions(ctx, cfg.presets);
  // [LAW:one-source-of-truth] A `from` NAME resolves against the domains render also uses.
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
  // [LAW:no-silent-failure] An unresolved `persistWhen` selector reads as "session" forever.
  for (const [name, a] of Object.entries(cfg.actions)) {
    if (!actionIsDual(a)) continue;
    const selector = a[PERSIST_WHEN];
    if (!declaresStateKey(cfg, selector)) {
      ctx.issues.push({
        path: `actions.${name}.${PERSIST_WHEN}`,
        message: `actions.${name} ${PERSIST_WHEN}: "${selector}" is not a declared state key — a dual action's selector must name a { kind: "state", key: "${selector}" } variable, or the destination can never change`,
        line: findKeyLine(ctx.source, ["actions", name, PERSIST_WHEN]),
      });
    }
  }
  // [LAW:no-silent-failure] A `persist`/`reset` key must land somewhere real, not merely parse.
  for (const [name, a] of Object.entries(cfg.actions)) {
    const key = "persist" in a ? a.persist : "reset" in a ? a.reset : null;
    if (key === null) continue;
    const discriminator = "persist" in a ? "persist" : "reset";
    const target = parsePersistTarget(key);
    if (target === null) {
      ctx.issues.push({
        path: `actions.${name}.${discriminator}`,
        message: `actions.${name}: "${key}" is not a config globals field (have: ${listGlobalsFieldNames().join(", ")}), a "segments.<name>.palette" target, or a "presets.<name>.root" target`,
        line: findKeyLine(ctx.source, ["actions", name, discriminator]),
      });
      continue;
    }
    // [LAW:single-enforcer] Only a preset-root target takes a tree op, and a tree op takes only one.
    const treeOps = TREE_OP_ARMS.filter((arm) => arm in a);
    if (target.scope !== "preset-root" && treeOps.length > 0) {
      ctx.issues.push({
        path: `actions.${name}.${discriminator}`,
        message: `actions.${name}: "${key}" is not a "presets.<name>.root" target — ${treeOps.map((arm) => `"${arm}"`).join("/")} is a tree op and applies only to one`,
        line: findKeyLine(ctx.source, ["actions", name, discriminator]),
      });
      continue;
    }
    if (target.scope === "preset-root") {
      checkPresetRootTarget(
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
    // [LAW:types-are-the-program] A palette is a NAME; a bounded stepper has no meaning over it.
    if ("min" in a) {
      ctx.issues.push({
        path: `actions.${name}.${discriminator}`,
        message: `actions.${name}: "${key}" is a segment palette target and cannot use a bounded stepper (min/max/by) — use "to", "from", or "cycle" instead`,
        line: findKeyLine(ctx.source, ["actions", name, discriminator]),
      });
    }
  }
  // [LAW:one-source-of-truth] THE resolvable names, mirroring the runtime store's keys.
  const templateScope = templateScopeOf(cfg);

  // [LAW:single-enforcer] ONE pre-order walk owns every layout cross-ref: segment
  // names resolve, each `when` references only declared variables.
  // [LAW:one-type-per-behavior] A preset's `root` gets that same walk.
  // [LAW:one-source-of-truth] The authored layout surface is read from parsed keys.
  // [LAW:single-enforcer] The menu precondition is synthesizeSettingsMenu's own predicate.
  const menuWillSynthesize = canHostSessionState(cfg);
  // [LAW:one-source-of-truth] The anchor is a position no config declares a segment for.
  // [LAW:types-are-the-program] Placed twice, one name-keyed open state serves two cells.
  const menuHosts = Object.entries(cfg.segments)
    .filter(([, seg]) => segmentReferencesMenu(seg.template))
    .map(([name]) => name);
  const checkPlacementCounts = (
    tree: LayoutNode,
    layoutKey: string,
    layoutLine: number | undefined,
  ): void => {
    if (countAnchors(tree) > 1) {
      ctx.issues.push({
        path: layoutKey,
        message: `${layoutKey} places the global settings menu anchor "${SETTINGS_ANCHOR}" ${countAnchors(tree)} times — it may appear at most once per layout (it is one disclosure, and one state key holds one open state). Remove all but the placement you want; removing every placement puts the menu at its default position.`,
        line: layoutLine,
      });
    }
    const placements = new Map<string, number>();
    for (const node of walkNodes(tree)) {
      if (node.kind === "segment") {
        placements.set(node.name, (placements.get(node.name) ?? 0) + 1);
      }
    }
    for (const name of menuHosts) {
      if ((placements.get(name) ?? 0) > 1) {
        ctx.issues.push({
          path: layoutKey,
          message: `segment "${name}" hosts a {{ menu }} and is placed in the layout more than once — a menu's open-state is keyed by segment name, so the copies would share one state (clicking one would toggle both). Give each placement its own named segment.`,
          line: layoutLine,
        });
      }
    }
  };
  // Walks what the author WROTE at this key, so errors name that layout, not an inherited row.
  const checkLayoutTree = (
    root: LayoutNode,
    layoutKey: string,
    layoutLine: number | undefined,
  ): void => {
    for (const node of walkNodes(root)) {
      // [LAW:locality-or-seam] A node's `when` reads the global scope, checked at load.
      if (node.when !== undefined) {
        checkTemplateRefs(ctx, `${layoutKey}.when`, node.when, templateScope, {
          line: layoutLine,
        });
      }
      if (node.kind !== "segment") continue;
      if (isSettingsAnchor(node.name)) {
        // [LAW:one-source-of-truth] Acceptance reads synthesizeSettingsMenu's own predicate.
        if (!menuWillSynthesize) {
          ctx.issues.push({
            path: layoutKey,
            message: `${layoutKey} places the global settings menu anchor "${SETTINGS_ANCHOR}", but this config declares no "${SESSION_ID_VAR}" variable — the menu is a click surface and every click composes a URL from "${SESSION_ID_VAR}", so it is not synthesized for a config without it. Declare a "${SESSION_ID_VAR}" variable (any config merged onto the bundled default inherits one) or remove the anchor placement.`,
            line: layoutLine,
          });
        }
        continue;
      }
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
  checkLayoutTree(
    rootNode(cfg.root),
    layoutKey,
    findKeyLine(ctx.source, [layoutKey]),
  );
  for (const [name, preset] of Object.entries(cfg.presets)) {
    if (preset.root === undefined) continue;
    const presetKey = `presets.${name}.root`;
    const presetLine = findKeyLine(ctx.source, ["presets", name, "root"]);
    checkLayoutTree(fragmentNode(preset.root), presetKey, presetLine);
  }
  // [LAW:one-source-of-truth] Counted over the tree each preset RENDERS.
  const rendered = new Map<string, LayoutNode>([["root", rootNode(cfg.root)]]);
  for (const name of presetNames(cfg.presets)) {
    const { node, path } = presetRoot(cfg, name);
    rendered.set(path, node);
  }
  for (const [key, tree] of rendered) {
    checkPlacementCounts(tree, key, findKeyLine(ctx.source, key.split(".")));
  }

  for (const [name, v] of Object.entries(cfg.variables)) {
    checkVarRefs(ctx, `variables.${name}`, v, templateScope);
  }

  for (const [segName, seg] of Object.entries(cfg.segments)) {
    // [LAW:one-source-of-truth] The same scope as everything else; locals only namespaced.
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
    // [LAW:locality-or-seam] bg/fg/when are templates too, so unknown refs fail at load.
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
      // [LAW:locality-or-seam] Action refs resolve against the merged action table.
      for (const aref of extractActionRefs(tpl)) {
        if (!Object.prototype.hasOwnProperty.call(cfg.actions, aref)) {
          ctx.issues.push({
            path: `segments.${segName}.${field}`,
            message: `${field} references unknown action "${aref}"`,
            line: findKeyLine(ctx.source, ["segments", segName, field]),
          });
        }
      }
      // [LAW:locality-or-seam] A menu binds the same action pair as a picker; one check covers both.
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

  // [LAW:verifiable-goals] state reads and `set` clicks both need the global
  // session.id anchor; surface it at load, not at first click.
  // [LAW:types-are-the-program] A segment-local "session.id" registers namespaced and
  // does not satisfy it.
  // [LAW:dataflow-not-control-flow] OR the triggers so an actions-only config demands it.
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

// [LAW:no-silent-failure] Preset must exist, arm must suit the scope, segments must be declared.
const TREE_OP_ARMS = [
  "removeSegment",
  "insertSegment",
  "insertSegmentFrom",
] as const;

function checkPresetRootTarget(
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
  // [LAW:one-source-of-truth] `reset` is a bare `{ reset: key }`, so what follows is persist-only.
  if (discriminator === "reset") return;
  const hasRemove = "removeSegment" in a;
  const hasInsert = "insertSegment" in a;
  // [LAW:one-source-of-truth] Its segment name is picked at render; only `anchor` is literal.
  const hasInsertFrom = "insertSegmentFrom" in a;
  if (!hasRemove && !hasInsert && !hasInsertFrom) {
    ctx.issues.push({
      path: at,
      message: `actions.${name}: "${key}" is a "presets.<name>.root" target and can only be paired with "removeSegment", "insertSegment", or "insertSegmentFrom" (not "to"/"from"/"cycle"/bounded — those have no meaning as a tree op)`,
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
  if (hasInsertFrom && "insertSegmentFrom" in a && missing(a.anchor)) {
    ctx.issues.push({
      path: at,
      message: `actions.${name}: anchor "${a.anchor}" is not a declared segment (have: ${Object.keys(cfg.segments).join(", ")})`,
      line,
    });
  }
}

// [LAW:one-source-of-truth] Both scopes: a global-only scan would reject working configs.
function stateVars(cfg: DslConfig): VariableDecl[] {
  return [
    ...Object.values(cfg.variables),
    ...Object.values(cfg.segments).flatMap((seg) =>
      Object.values(seg.vars ?? {}),
    ),
  ].filter((v) => v.kind === "state");
}

function hasStateKind(cfg: DslConfig): boolean {
  return stateVars(cfg).length > 0;
}

function declaresStateKey(cfg: DslConfig, key: string): boolean {
  return stateVars(cfg).some((v) => v.kind === "state" && v.key === key);
}

// [LAW:dataflow-not-control-flow] Needed when any declared action carries session.id on the wire.
function hasActionSetAction(cfg: DslConfig): boolean {
  return Object.values(cfg.actions).some(
    (a) =>
      actionBindsSet(a) ||
      actionBindsPersist(a) ||
      actionBindsReset(a) ||
      actionBindsUndo(a) ||
      actionBindsRedo(a) ||
      actionBindsDoctor(a),
  );
}

// [LAW:one-source-of-truth] The one scope every reference surface resolves against.
function templateScopeOf(cfg: DslConfig): TemplateScope {
  const names = new Set<string>();
  const documents = new Set<string>();
  const declare = (name: string, v: VariableDecl): void => {
    names.add(name);
    if (isDocumentDecl(v)) documents.add(name);
  };
  for (const [name, v] of Object.entries(cfg.variables)) declare(name, v);
  for (const [segName, seg] of Object.entries(cfg.segments)) {
    for (const [name, v] of Object.entries(seg.vars ?? {})) {
      declare(`${segName}.${name}`, v);
    }
  }
  return { names, documents };
}

function isDocumentDecl(v: VariableDecl): boolean {
  return (
    (v.kind === "shell" || v.kind === "file") && parseArm(v.parse) === "json"
  );
}

function checkVarRefs(
  ctx: ValidateCtx,
  declPath: string,
  v: VariableDecl,
  scope: TemplateScope,
  segCtx?: string,
): void {
  if (v.kind === "template") {
    checkTemplateRefs(ctx, `${declPath}.template`, v.template, scope, {
      segCtx,
    });
  }
  if (hasCacheField(v)) {
    if (v.cache && "key" in v.cache) {
      checkTemplateRefs(ctx, `${declPath}.cache.key`, v.cache.key, scope, {
        segCtx,
      });
    }
  }
}

function checkDependsOn(
  ctx: ValidateCtx,
  declPath: string,
  v: VariableDecl,
  scope: TemplateScope,
  segCtx?: string,
): void {
  if (!hasCacheField(v)) return;
  if (!v.cache) return;
  if (!("depends_on" in v.cache)) return;
  for (let i = 0; i < v.cache.depends_on.length; i++) {
    const target = v.cache.depends_on[i]!;
    // [LAW:one-source-of-truth] Exact membership, not refResolves: a dotted prefix
    // resolvable in a template is not a store key and would throw at runtime.
    if (scope.names.has(target)) continue;
    const namespaced = segCtx !== undefined ? `${segCtx}.${target}` : undefined;
    const hint =
      namespaced !== undefined && scope.names.has(namespaced)
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
  scope: TemplateScope,
  opts?: {
    // [LAW:one-source-of-truth] Callers with no literal source key path pass the line.
    line?: number;
    // A diagnostic hint only, never a resolution rule.
    segCtx?: string;
  },
): void {
  for (const ref of extractTemplateRefs(template)) {
    if (refResolves(ref, scope)) continue;
    const namespaced =
      opts?.segCtx !== undefined ? `${opts.segCtx}.${ref}` : undefined;
    const hint =
      namespaced !== undefined && refResolves(namespaced, scope)
        ? ` (segment-local vars are namespaced — write ".${namespaced}")`
        : "";
    ctx.issues.push({
      path: declPath,
      message: `Template references unknown variable ".${ref}"${hint}`,
      line: opts?.line ?? findKeyLine(ctx.source, declPath.split(".")),
    });
  }
}

// [LAW:one-source-of-truth] Read from parsed top-level keys, not a text search.
function authoredLayoutKey(source: string): "root" | "layout" {
  try {
    const parsed = JSON5.parse(source);
    if (isPlainObject(parsed) && "root" in parsed) return "root";
  } catch {
    // A real syntax error is already reported before cross-ref runs.
  }
  return "layout";
}
