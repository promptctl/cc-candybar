// [LAW:single-enforcer] All cross-reference resolution on the MERGED config:
// layout nodes name declared segments, every template-bearing field references
// only existing variables/actions, and depends_on points at declared variables.
// (session.id needs no check: the settings menu, synthesized into every
// config, ensures it.) Runs after merge so a
// user surface can reference default-provided segments/actions. This file changes
// when the visibility/scoping rules between config parts change.

import {
  describeSettingDomain,
  hasCacheField,
  inSettingDomain,
  rangeOf,
  settingOrderProblems,
  settingsOf,
  type SettingOrderProblem,
  type SettingValue,
  type SettingDecl,
  freePlacementId,
  placementId,
  placementIds,
  walkNodes,
  AXIS_OF,
  type DslConfig,
  type LayoutNode,
  type PresetDecl,
  type RawDslConfig,
  type RootFragment,
  type SegmentDecl,
  type SegmentNode,
  type VariableDecl,
} from "../dsl-types.js";
import { actionBindsTemplateValue, type ActionDecl } from "../action.js";
import {
  knownOptionDomainNames,
  perConfigDomainsFor,
} from "../option-domain.js";
import { listGlobalsFieldNames } from "./globals.js";
import {
  isExpression,
  isEndcaps,
  retiredThemeNote,
} from "../../themes/policy.js";
import { endcapsNameMessage } from "./styles.js";
import { parsePersistTarget } from "./persist-target.js";
import { presetNames, presetRoot } from "../presets.js";
import { fragmentNodePaths, rootNode } from "../root.js";
import {
  anchorUnderGate,
  countAnchors,
  isSettingsAnchor,
  SETTINGS_ANCHOR,
} from "../settings-menu.js";
import { ident } from "../ident.js";
import { findKeyLine } from "./diagnostics.js";
import { RENAMED_SEGMENTS, renamedHint } from "./renamed-segments.js";
import {
  retiredReadHint,
  retiredVariableMessage,
} from "./retired-variables.js";
import { SYNTAX_ENGINE } from "./syntax-engine.js";
import { type ValidateCtx } from "./validate-core.js";
import {
  templateActionRefs,
  templateReads,
  refResolves,
  templateScopeOf,
  type TemplateScope,
} from "./refs.js";

// [LAW:single-enforcer] Runs HERE — on `cfg.presets`, the MERGED map — not
// in loader/presets.ts's per-file structural pass (where a round-1 version
// of this check lived): that pass validates one config source at a time
// (the bundled default's own RAW_DEFAULT_DSL_CONFIG, or a user's file,
// independently), so it could only ever catch a collision between two
// preset names declared in ONE source. synthesizeEditChrome — the thing
// this guard protects, which keys its per-preset reset action/segment (and
// the pre-existing per-gap +/- actions) by `ident(presetName)` in a plain
// object accumulator with no re-entrant cross-ref check — runs on the
// MERGED config (dsl-loader.ts), so the collision it can actually produce
// is a merged one: a user preset whose ident collides with a name the
// BUNDLED library or a different file contributed. This is the one place
// that sees that merged set, so it's the one place that can prove no
// collision exists in it.
//
// [LAW:one-source-of-truth] `ident` is imported from ../ident.ts — the ONE
// collapse rule menu-keys.ts, edit-chrome.ts, and this guard all now share,
// so a future tweak to the rule can't silently desync the guard from the
// thing it checks.
//
// [LAW:no-silent-failure] Two preset names that collapse to the SAME
// synthesis identifier (e.g. "quick-look" and "quick_look" both → "quick_
// look") would silently steal each other's synthesized artifacts: the
// SECOND preset processed overwrites the first's entries, leaving the
// first preset's already-built tree holding a segment ref to a name that
// now points at the second preset's reset action. A user clicking "reset"
// on preset A would silently reset preset B instead.
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
  authored: RawDslConfig,
): void {
  // [LAW:locality-or-seam] globals.style names a member of the MERGED styles
  // block (a user's default may be a bundled style — same reason every cross-ref
  // runs post-merge). Same existence-check shape as layout→segments; an unknown
  // name is a load error, never a silent identity fallback.
  //
  // An EXPRESSION in that slot is exempt (brandon-looks-pe6): it names no style,
  // it names the RULE for choosing one per render, so there is nothing here to
  // check membership of. Its result gets the same forgiveness a stale session
  // pick does (`decideStyleName` collapses a non-member to the floor), and its
  // own well-formedness is checked where every other template's is — parsed
  // eagerly by registerDslConfig, so a malformed one is still a load error.
  // `isExpression` is the ONE predicate every reader uses, so this exemption
  // cannot be wider or narrower than what the render will actually evaluate.
  //
  // [LAW:one-type-per-behavior] Every globals fragment a style NAME can come from
  // is checked the same way — the config's own, each preset's, and editGlobals —
  // because each is a rung the resolution reads, and a name no rung can decide
  // falls through to the next in silence (brandon-themes-owl).
  const styleFragments: ReadonlyArray<
    readonly [readonly string[], string | undefined]
  > = [
    [["globals"], cfg.globals.style],
    [["editGlobals"], cfg.editGlobals.style],
    ...Object.entries(cfg.presets).map(
      ([name, preset]) =>
        [["presets", name, "globals"], preset.globals?.style] as const,
    ),
  ];
  for (const [at, name] of styleFragments) {
    if (
      name === undefined ||
      isExpression(name) ||
      Object.prototype.hasOwnProperty.call(cfg.styles, name)
    )
      continue;
    const where = `${at.join(".")}.style`;
    ctx.issues.push({
      path: where,
      message: isEndcaps(name)
        ? endcapsNameMessage(where, name, `${at.join(".")}.endcaps`)
        : `${where} "${name}" does not match any declared style (have: ${Object.keys(cfg.styles).join(", ")})`,
      line: findKeyLine(ctx.source, [...at, "style"]),
    });
  }
  // [LAW:one-type-per-behavior] globals.preset is globals.style one dimension
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
  presetIdentCollisions(ctx, cfg.presets);
  // [LAW:one-source-of-truth] A `set … from` NAME must resolve — checked
  // against this config's per-config domains ("styles", the merged styles:
  // block) plus the global registry (themes/styles, and any future
  // registration), the SAME set resolveOptionDomain consults at render and
  // gate-derivation time. An inline array `from` is its own domain — nothing
  // to resolve. Runs post-merge for the same reason globals.style does above:
  // "styles" isn't fully known until the user's styles: block has merged onto
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
  // [LAW:no-silent-failure] A `do` action's members resolve against the merged
  // action table, like every other action reference. Two shapes are refused
  // here rather than realized wrongly. A member that is itself a `do` gains
  // nothing a flat list would not say, and admitting it would admit a cycle.
  // A follower that takes its value from the template would be handed the
  // head's display as that value, since only the head is bound one. A member
  // listed twice is a typo either way: a cycle realized twice against one
  // render's state toggles once, a stepper twice steps twice.
  for (const [name, a] of Object.entries(cfg.actions)) {
    if (!("do" in a)) continue;
    a.do.forEach((member, i) => {
      const target = Object.prototype.hasOwnProperty.call(cfg.actions, member)
        ? cfg.actions[member]!
        : undefined;
      const problem =
        target === undefined
          ? `references unknown action "${member}"`
          : "do" in target
            ? `"${member}" is itself a do action — list its members here instead`
            : a.do.indexOf(member) !== i
              ? `"${member}" is listed twice — each member fires once per click`
              : i > 0 && actionBindsTemplateValue(target)
                ? `"${member}" takes its value from the template (from/int/insertSegmentFrom), so it can only be the first member — only the first is bound the region's display`
                : undefined;
      if (problem !== undefined) {
        ctx.issues.push({
          path: `actions.${name}.do`,
          message: `actions.${name} do: ${problem}`,
          line: findKeyLine(ctx.source, ["actions", name, "do"]),
        });
      }
    });
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
        message: `actions.${name}: "${key}" is not a config globals field (have: ${listGlobalsFieldNames().join(", ")}), a "segments.<name>.palette" target, a "presets.<name>.globals.<field>" target, or a "presets.<name>.root" target`,
        line: findKeyLine(ctx.source, ["actions", name, discriminator]),
      });
      continue;
    }
    // [LAW:single-enforcer] The arm-pairing check in both directions: a
    // tree op names a preset-root target (checkPresetRootTarget rejects the
    // absence), and only a preset-root target takes a tree op — otherwise
    // the click's own "not a presets.<name>.root target" is the first sign.
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
    if (
      target.scope === "preset-globals" &&
      !presetNames(cfg.presets).includes(target.preset)
    ) {
      ctx.issues.push({
        path: `actions.${name}.${discriminator}`,
        message: `actions.${name}: "${key}" names preset "${target.preset}" which is not declared (have: ${presetNames(cfg.presets).join(", ")})`,
        line: findKeyLine(ctx.source, ["actions", name, discriminator]),
      });
      continue;
    }
    if (target.scope !== "segment-palette") continue;
    if (!Object.prototype.hasOwnProperty.call(cfg.segments, target.segment)) {
      ctx.issues.push({
        path: `actions.${name}.${discriminator}`,
        message: `actions.${name}: "${key}" names segment "${target.segment}" which is not declared (have segments: ${Object.keys(cfg.segments).join(", ")})${renamedHint(target.segment)}`,
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
  const templateScope = templateScopeOf(cfg);
  // [LAW:one-source-of-truth] `.settings` in a segment's templates is its
  // placement's settings, so no variable may be stored under that name — it
  // would be a second thing `.settings.x` could mean. Asked of the store's own
  // key set, which holds segment locals too (`<segment>.<var>`).
  for (const name of templateScope.names) {
    if (name !== "settings" && !name.startsWith(SETTINGS_SCOPE_PREFIX))
      continue;
    ctx.issues.push({
      path: "variables",
      message: `variable "${name}" is named under "settings", which a segment's templates read as its placement's own settings (.settings.<name>) — rename it`,
      line: findKeyLine(ctx.source, ["variables", name]),
    });
  }

  // [LAW:single-enforcer] ONE pre-order walk owns every layout cross-ref:
  // each segment a layout names must resolve to a declared segment — in the
  // MERGED config, so a file can place a bundled segment without re-declaring
  // it — and any node's `when` predicate (a template like any other) must
  // reference only existing variables. The walk covers the fragments the FILE
  // wrote (checkLayoutTree), so its paths and lines are the author's own.
  //
  // [LAW:one-type-per-behavior] A PRESET's `root` is a root: it gets this exact
  // walk, not a reduced copy. The only thing that varies between the config's
  // own tree and a preset's is the diagnostic key + line — data threaded in,
  // never a second traversal that could learn a different idea of what a valid
  // layout is. This is what makes `cc-candybar check` catch a preset staging a
  // segment nobody declared.

  // [LAW:one-source-of-truth] The global settings menu's anchor is a POSITION
  // an author may place and the walk below must therefore accept, even though
  // no config declares a segment by that name — synthesizeSettingsMenu provides
  // it in every config, immediately after these checks pass. Two placements is
  // the real error: one state key holds one open state, so a second anchor
  // would be a second toggle writing one disclosure, with two bodies claiming
  // to be it. Counted over the SAME census the synthesis reads, so "placed"
  // means one thing [LAW:single-enforcer] — and over the tree that RENDERS
  // (the preset's fragment merged over the config's root, presetRoot), because
  // a `{ rows }` fragment and a row it inherits can each place one.
  //
  // [LAW:types-are-the-program] Every placement's identity is its id
  // (`placementId`), and one id names one placement: a menu's open state,
  // edit mode's `✖`, and the config-file editor all address a placement by
  // it, so two placements sharing one would share all three. Counted over the
  // same rendered tree, for the same reason.
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
    if (anchorUnderGate(tree)) {
      ctx.issues.push({
        path: layoutKey,
        message: `${layoutKey} places the global settings menu anchor "${SETTINGS_ANCHOR}" under a \`when\` or inside a disclosure body — the menu is visible under every condition, so its placement may not be gated. Move it to an ungated position, or remove it to put the menu at its default position.`,
        line: layoutLine,
      });
    }
    if (distributionInsideCell(tree)) {
      ctx.issues.push({
        path: layoutKey,
        message: `${layoutKey} sets "distribution" on a container inside a bar cell — everything inside a cell wears that cell's hue and tone, so it would place nothing. Set it on the row whose children are the cells (the horizontal container) or on the root, which places the rows.`,
        line: layoutLine,
      });
    }
    const byId = new Map<string, SegmentNode[]>();
    for (const node of walkNodes(tree)) {
      if (node.kind !== "segment") continue;
      const id = placementId(node);
      byId.set(id, [...(byId.get(id) ?? []), node]);
    }
    for (const [id, nodes] of byId) {
      if (nodes.length < 2) continue;
      const seg = nodes[1]!.name;
      const free = freePlacementId(seg, new Set(byId.keys()));
      ctx.issues.push({
        path: layoutKey,
        message: `${layoutKey} has ${nodes.length} placements with the id "${id}" — an id names one placement (its settings, its menus' open state, and edit mode all address it), so give each its own: { seg: "${seg}", id: "${free}" }. A placement without an "id" takes its segment's name.`,
        line: layoutLine,
      });
    }
  };
  // [LAW:no-silent-failure] The bar reads two steps of an address — the
  // innermost row, and the cell of that row (decorEntryFor) — so a container
  // nested inside a cell has no step the bar reads, and its `distribution`
  // would be accepted and ignored. A disclosure body is a band, whose items
  // are placed by every step (bandAxis), so the walk stops at `opens`.
  function distributionInsideCell(node: LayoutNode, inCell = false): boolean {
    if (node.kind === "segment") return false;
    return (
      (inCell && node.distribution !== undefined) ||
      node.children.some((child) =>
        distributionInsideCell(
          child,
          inCell || AXIS_OF[node.direction] === "cell",
        ),
      )
    );
  }
  // [LAW:one-source-of-truth] Walks what the author WROTE — the file's own
  // fragment at this key, never the merged root — so a node is reported at
  // the path, and on the line, the author would look for it, and a row they
  // inherited is not theirs to be told about. The tree that renders is checked
  // below (placement counts); an inherited row names only bundled segments,
  // which no file can remove.
  const checkLayoutTree = (root: RootFragment, layoutKey: string): void => {
    for (const [node, path] of fragmentNodePaths(root, layoutKey)) {
      const line = findKeyLine(ctx.source, path.split("."));
      // [LAW:locality-or-seam] A node's `when` reads the global scope (bare
      // globals + namespaced segment vars) — the same existence-check shape as a
      // segment template, surfaced at load time.
      if (node.when !== undefined) {
        checkTemplateRefs(ctx, `${path}.when`, node.when, templateScope, {
          line,
        });
        checkWhenParses(ctx, `${path}.when`, node.when, line);
      }
      if (node.kind !== "segment") continue;
      // [LAW:one-source-of-truth] The anchor is a position, not a declared
      // segment: synthesizeSettingsMenu lowers it in every config, right after
      // these checks pass. The menu it lowers to is chrome, not a placement:
      // an `id` or `settings` on it would configure nothing.
      // [LAW:no-silent-failure]
      if (isSettingsAnchor(node.name)) {
        if (node.id !== undefined || node.settings !== undefined) {
          ctx.issues.push({
            path,
            message: `${layoutKey} gives the global settings menu anchor "${SETTINGS_ANCHOR}" an id or settings — the anchor only marks where the menu goes, so place it as the bare name "${SETTINGS_ANCHOR}"`,
            line,
          });
        }
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(cfg.segments, node.name)) {
        ctx.issues.push({
          path,
          message: `${layoutKey} entry "${node.name}" does not match any declared segment${renamedHint(node.name)}`,
          line,
        });
      }
      checkPlacementSettings(ctx, cfg, node, path, line);
    }
  };
  if (authored.root !== undefined) checkLayoutTree(authored.root, "root");
  for (const [name, preset] of Object.entries(authored.presets ?? {})) {
    if (preset.root !== undefined) {
      checkLayoutTree(preset.root, `presets.${name}.root`);
    }
  }
  // [LAW:one-source-of-truth] Placement counts run over the tree each preset
  // RENDERS, keyed by the path presetRoot reports it authored at — so a
  // fragment that is the merge identity collapses onto `root` by data and is
  // neither re-walked nor reported under a path nothing edits.
  const rendered = new Map<string, LayoutNode>([["root", rootNode(cfg.root)]]);
  for (const name of presetNames(cfg.presets)) {
    const { node, path } = presetRoot(cfg, name);
    rendered.set(path, node);
  }
  for (const [key, tree] of rendered) {
    checkPlacementCounts(tree, key, findKeyLine(ctx.source, key.split(".")));
  }

  // For each variable's template/cache.key, every dotted ref must exist
  // (full path OR a prefix that matches an existing variable's namespace).
  for (const [name, v] of Object.entries(cfg.variables)) {
    checkVarRefs(ctx, `variables.${name}`, v, templateScope);
    const retired = retiredVariableMessage(name);
    if (retired !== undefined) {
      ctx.issues.push({
        path: `variables.${name}`,
        message: retired,
        line: findKeyLine(ctx.source, ["variables", name]),
      });
    }
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
    // [LAW:one-source-of-truth] A segment's own templates also read
    // `.settings.<name>` — the placement's value for each setting the
    // segment declares, and nothing else under that name.
    const settings = settingsOf(seg);
    checkSettingOrder(ctx, segName, settings);
    const segScope = withSettingsScope(templateScope, settings);
    for (const field of ["template", "bg", "fg", "when"] as const) {
      const tpl = seg[field];
      if (typeof tpl !== "string") continue;
      checkTemplateRefs(ctx, `segments.${segName}.${field}`, tpl, segScope, {
        segCtx: segName,
        settings,
      });
      // [LAW:locality-or-seam] `{{ action "name" … }}` refs, and the option
      // domain a `{{ picker }}`/`{{ menu }}`/`{{ carousel }}` lays out, resolve
      // against the action table on the merged config — so a segment can
      // reference a default-provided action — through every helper the field
      // calls, exactly as its variable reads do.
      for (const { name: aref, site, via } of templateActionRefs(
        tpl,
        cfg.helpers,
      )) {
        if (Object.prototype.hasOwnProperty.call(cfg.actions, aref)) continue;
        const inOptions =
          site === "options" ? " (in a picker, menu or carousel)" : "";
        if (via !== null) {
          checkHelperIssue(
            ctx,
            via,
            `Template references unknown action "${aref}"${inOptions}`,
          );
          continue;
        }
        ctx.issues.push({
          path: `segments.${segName}.${field}`,
          message: `${field} references unknown action "${aref}"${inOptions}`,
          line: findKeyLine(ctx.source, ["segments", segName, field]),
        });
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
}

// [LAW:no-silent-failure] brandon-layout-edit-2gc.1's structural-edit target
// check, one arm of the persist/reset key cross-ref above. Three things must
// hold at load time, same spirit as the segment-palette check just above it:
// the preset name must be real (mirrors globals.preset's check earlier in
// this function), the arm pairing must make sense for this scope (only
// removeSegment/insertSegment address a tree — a `to`/`from`/cycle/bounded
// literal has no meaning as "a tree"), and a segment an insertion names must
// be declared. The placements an op addresses by id are the click's to check.
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
  // [LAW:one-source-of-truth] `reset` has no value-source arm to check — its
  // shape is a bare `{ reset: key }` — so the arm-pairing/segment checks
  // below are `persist`-only, exactly as the "reset" action's clean-slate
  // undo is meant to be: it deletes the whole authored root regardless of
  // what wrote it.
  if (discriminator === "reset") return;
  const hasRemove = "removeSegment" in a;
  const hasInsert = "insertSegment" in a;
  // [LAW:one-source-of-truth] brandon-layout-edit-2gc.3's domain-sourced
  // sibling — the segment name is picked at render, so only `anchor` (still
  // literal at author time) needs the declared-segment check below.
  const hasInsertFrom = "insertSegmentFrom" in a;
  if (!hasRemove && !hasInsert && !hasInsertFrom) {
    ctx.issues.push({
      path: at,
      message: `actions.${name}: "${key}" is a "presets.<name>.root" target and can only be paired with "removeSegment", "insertSegment", or "insertSegmentFrom" (not "to"/"from"/"cycle"/bounded — those have no meaning as a tree op)`,
      line,
    });
    return;
  }
  // [LAW:single-enforcer] One spelling for every tree-op segment reference.
  const checkDeclared = (role: string, segName: string): void => {
    if (Object.prototype.hasOwnProperty.call(cfg.segments, segName)) return;
    ctx.issues.push({
      path: at,
      message: `actions.${name}: ${role} "${segName}" is not a declared segment (have: ${Object.keys(cfg.segments).join(", ")})${renamedHint(segName)}`,
      line,
    });
  };
  // [LAW:single-enforcer] A removal's target and an insertion's anchor are
  // PLACEMENT ids, which name positions in a tree the op itself rewrites — an
  // authored `removeSegment` names a placement that is gone once it has run,
  // so a load-time check would refuse the very config its own click wrote.
  // The one enforcer is the click: the file store refuses an id the tree no
  // longer holds, loudly, and leaves the file untouched. The load still
  // points a RETIRED segment name at its successor (renamed-segments.ts) —
  // a name nothing declares and no placement holds, so no click of this
  // config's can have removed it.
  const placed = new Set(placementIds(presetRoot(cfg, presetName).node));
  const checkRetired = (role: string, id: string): void => {
    if (
      !RENAMED_SEGMENTS.has(id) ||
      placed.has(id) ||
      Object.prototype.hasOwnProperty.call(cfg.segments, id)
    ) {
      return;
    }
    ctx.issues.push({
      path: at,
      message: `actions.${name}: ${role} "${id}" names no placement${renamedHint(id)}`,
      line,
    });
  };
  if ("removeSegment" in a) checkRetired("removeSegment", a.removeSegment);
  if ("insertSegment" in a) checkDeclared("insertSegment", a.insertSegment);
  if ("insertSegment" in a || "insertSegmentFrom" in a) {
    checkRetired("anchor", a.anchor);
  }
}

// `.settings.` — a read under it is one of the placement's settings.
const SETTINGS_SCOPE_PREFIX = "settings.";

// [LAW:one-source-of-truth] The scope a segment's own templates check
// against: everything any template may read, plus `settings.<name>` for each
// setting the segment declares — the same keys the render's placement scope
// adds (src/template-engine/scope.ts), and no others.
function withSettingsScope(
  scope: TemplateScope,
  settings: Readonly<Record<string, SettingDecl>>,
): TemplateScope {
  return {
    ...scope,
    names: new Set([
      ...scope.names,
      ...Object.keys(settings).map((n) => SETTINGS_SCOPE_PREFIX + n),
    ]),
  };
}

// [LAW:no-silent-failure] A declaration's `atLeast` relations, over the MERGED
// settings (a file may redeclare one setting of a bundled segment, and the
// setting it names may be the bundled one): each names another range setting
// of the segment, no chain of them closes a cycle (every setting on one could
// only ever equal the rest, so no stepper click could move any of them), and
// the defaults stand together under every relation.
function checkSettingOrder(
  ctx: ValidateCtx,
  segName: string,
  settings: Readonly<Record<string, SettingDecl>>,
): void {
  const at = (name: string): string => `segments.${segName}.settings.${name}`;
  const push = (name: string, message: string): void => {
    ctx.issues.push({
      path: at(name),
      message: `${at(name)}: ${message}`,
      line: findKeyLine(ctx.source, ["segments", segName, "settings", name]),
    });
  };
  const broken = floorProblems(settings);
  for (const { setting, message } of broken) push(setting, message);
  if (broken.length > 0) return;
  for (const { setting, message } of settingOrderProblems(
    settings,
    defaultsOf(settings),
  )) {
    push(setting, `the defaults do not stand together: ${message}`);
  }
}

// Whether the declaration's relations were already reported by
// checkSettingOrder — then no placement repeats them.
function relationsReported(
  settings: Readonly<Record<string, SettingDecl>>,
): boolean {
  return (
    floorProblems(settings).length > 0 ||
    settingOrderProblems(settings, defaultsOf(settings)).length > 0
  );
}

function defaultsOf(
  settings: Readonly<Record<string, SettingDecl>>,
): Record<string, SettingValue> {
  return Object.fromEntries(
    Object.entries(settings).map(([n, d]) => [n, d.default]),
  );
}

// Each `atLeast` that names no OTHER range setting of the segment, and each
// cycle of them (reported once, at its first member by name). The relations
// are asked of values only when this is empty.
function floorProblems(
  settings: Readonly<Record<string, SettingDecl>>,
): readonly SettingOrderProblem[] {
  const floorOf = (name: string): string | undefined =>
    rangeOf(own(settings, name))?.atLeast;
  return Object.keys(settings).flatMap((name): SettingOrderProblem[] => {
    const floor = floorOf(name);
    if (floor === undefined) return [];
    if (floor === name || rangeOf(own(settings, floor)) === undefined) {
      return [
        {
          setting: name,
          message: `atLeast "${floor}" must name another range setting of this segment (its range settings: ${rangeSettingNames(settings, name).join(", ") || "none"})`,
        },
      ];
    }
    const chain = [name];
    for (
      let next: string | undefined = floor;
      next !== undefined;
      next = floorOf(next)
    ) {
      if (next === name) {
        return chain.every((member) => name <= member)
          ? [
              {
                setting: name,
                message: `atLeast closes a cycle (${[...chain, name].join(" ≥ ")}) — every setting on it could only ever equal the rest`,
              },
            ]
          : [];
      }
      if (chain.includes(next)) return [];
      chain.push(next);
    }
    return [];
  });
}

function own(
  settings: Readonly<Record<string, SettingDecl>>,
  name: string,
): SettingDecl | undefined {
  return Object.prototype.hasOwnProperty.call(settings, name)
    ? settings[name]
    : undefined;
}

function rangeSettingNames(
  settings: Readonly<Record<string, SettingDecl>>,
  except: string,
): string[] {
  return Object.entries(settings)
    .filter(([n, decl]) => n !== except && rangeOf(decl) !== undefined)
    .map(([n]) => n);
}

// [LAW:no-silent-failure] A placement's setting values, against the merged
// declaration of its segment: every name must be one it declares, every value
// inside that setting's domain. A placement of an undeclared segment is
// reported by the layout walk; nothing here is asked of it.
function checkPlacementSettings(
  ctx: ValidateCtx,
  cfg: DslConfig,
  node: SegmentNode,
  layoutKey: string,
  line: number | undefined,
): void {
  const seg = Object.prototype.hasOwnProperty.call(cfg.segments, node.name)
    ? cfg.segments[node.name]!
    : undefined;
  if (seg === undefined) return;
  const declared = settingsOf(seg);
  const where = `${layoutKey}: placement "${placementId(node)}" of segment "${node.name}"`;
  for (const [setting, value] of Object.entries(node.settings ?? {})) {
    const decl = Object.prototype.hasOwnProperty.call(declared, setting)
      ? declared[setting]!
      : undefined;
    const problem =
      decl === undefined
        ? `sets "${setting}", which segment "${node.name}" does not declare (it has: ${Object.keys(declared).join(", ")})`
        : inSettingDomain(decl, value)
          ? undefined
          : `sets "${setting}" to ${JSON.stringify(value)}${decl.domain === "theme" ? retiredThemeNote(value) : ""}, but it must be ${describeSettingDomain(decl)}`;
    if (problem !== undefined) {
      ctx.issues.push({
        path: layoutKey,
        message: `${where} ${problem}`,
        line,
      });
    }
  }
  // Values out of their domains were reported above; the relations are asked
  // of the placement's resolved values only once every one is a member.
  const resolved = Object.fromEntries(
    Object.entries(declared).map(([n, d]) => [
      n,
      node.settings?.[n] ?? d.default,
    ]),
  );
  const members = Object.entries(resolved).every(([n, v]) =>
    inSettingDomain(declared[n]!, v),
  );
  if (!members || relationsReported(declared)) return;
  for (const { message } of settingOrderProblems(declared, resolved)) {
    ctx.issues.push({ path: layoutKey, message: `${where}: ${message}`, line });
  }
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
    // [LAW:one-source-of-truth] Exact membership, not refResolves: the
    // depends_on reaction calls store.changeKey(name) with each listed name
    // verbatim, and the store is an exact-key map. A dotted prefix that
    // merely navigates INTO a value (resolvable in a template) is not a
    // store key and would throw at runtime.
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

// [LAW:no-silent-failure] A malformed `when` in an authored tree is a load
// error at its position in that tree, before any synthesis. The compile would
// catch it too, but it
// compiles the SYNTHESIZED trees — the settings menu and edit chrome rewrite
// every preset root — so its path would name a position the author never
// wrote (`presets.default.root.children[1]…`).
function checkWhenParses(
  ctx: ValidateCtx,
  path: string,
  when: string,
  line: number | undefined,
): void {
  try {
    SYNTAX_ENGINE.parse(when);
  } catch (e) {
    ctx.issues.push({
      path,
      message: `Template parse error in ${path}: ${(e as Error).message}`,
      line,
    });
  }
}

function checkTemplateRefs(
  ctx: ValidateCtx,
  declPath: string,
  template: string,
  scope: TemplateScope,
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
    // The settings that segment declares, so a read of one it does not
    // declare says which it does.
    settings?: SegmentDecl["settings"];
  },
): void {
  for (const [ref, via] of templateReads(template, scope.helpers)) {
    if (refResolves(ref, scope)) continue;
    // [LAW:single-enforcer] A setting is the CALLER's declaration, never the
    // helper's: `.settings` binds to whichever placement renders, so a helper
    // reading one is correct and the fix is on the template that called it.
    if (ref.startsWith(SETTINGS_SCOPE_PREFIX)) {
      const through = via === null ? "" : ` through helper "${via}"`;
      const setting = ref.slice(SETTINGS_SCOPE_PREFIX.length);
      // `settings` is passed exactly for a segment's own templates — the ones
      // a placement renders; a variable (a segment-local one included) has no
      // placement, so no declaration could make its read valid.
      const message =
        opts?.segCtx === undefined || opts.settings === undefined
          ? `Template reads ".${ref}"${through}, but only a segment's own templates have settings — call it from a segment that declares "${setting}"`
          : `Template reads ".${ref}"${through}, but segment "${opts.segCtx}" has no setting "${setting}" (it has: ${Object.keys(opts.settings).join(", ")}) — declare it under segments.${opts.segCtx}.settings`;
      ctx.issues.push({
        path: declPath,
        message,
        line: opts?.line ?? findKeyLine(ctx.source, declPath.split(".")),
      });
      continue;
    }
    if (via !== null) {
      checkHelperIssue(
        ctx,
        via,
        `Template references unknown variable ".${ref}"${retiredReadHint(ref)}`,
      );
      continue;
    }
    const namespaced =
      opts?.segCtx !== undefined ? `${opts.segCtx}.${ref}` : undefined;
    const hint =
      namespaced !== undefined && refResolves(namespaced, scope)
        ? ` (segment-local vars are namespaced — write ".${namespaced}")`
        : retiredReadHint(ref);
    ctx.issues.push({
      path: declPath,
      message: `Template references unknown variable ".${ref}"${hint}`,
      line: opts?.line ?? findKeyLine(ctx.source, declPath.split(".")),
    });
  }
}

// A helper's unknown ref — a variable or an action — is the helper's error,
// reported at the helper — the
// one place the author fixes it, in their file when they override a bundled
// helper — and ONCE, however many templates reach it.
function checkHelperIssue(
  ctx: ValidateCtx,
  helper: string,
  message: string,
): void {
  const path = `helpers.${helper}`;
  if (ctx.issues.some((i) => i.path === path && i.message === message)) return;
  ctx.issues.push({
    path,
    message,
    line: findKeyLine(ctx.source, ["helpers", helper]),
  });
}
