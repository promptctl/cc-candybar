// [LAW:one-source-of-truth] brandon-layout-edit-2gc.3's CHROME half — the
// LOWERING that turns "edit mode is a session toggle" into "each row's
// segments render interleaved with +/- affordances" without a render-walk
// branch [LAW:dataflow-not-control-flow]. Follows the SAME move `kind:
// "group"` sugar makes (src/config/loader/layout.ts): one pass produces a NEW
// tree with synthesized nodes spliced in, each gated by an ordinary `when` —
// the walk that renders it learns nothing new. The difference from group
// sugar is WHEN this can run: a group is authored data, lowered per file
// before merge; edit chrome is DERIVED from which segments are actually in
// the tree, which is only known after merge, preset-root resolution, and
// rootOps replay. So this runs from validateConfig, on the fully resolved
// config each declared preset stages — see synthesizeEditChrome below.
//
// [LAW:single-enforcer] The +/- affordances reuse EXISTING primitives
// wholesale rather than inventing parallel ones: `-` is an ordinary
// `{ persist, removeSegment }` action behind `{{ action }}` (2gc.1); `+` is an
// ordinary `{ persist, insertSegmentFrom }` action behind `{{ menu }}`
// (2gc.3's new arm — see action.ts), synthesized by calling the SAME pure
// functions `{{ menu }}`'s own load-time synthesis calls
// (menu-keys.ts/disclosure.ts) so a synthesized menu and a hand-authored one
// are indistinguishable at render. Nothing here is a new render concept.

import type { ActionDecl as ActionDeclType, OptionDomain } from "./action.js";
import type {
  ContainerNode,
  DslConfig,
  LayoutNode,
  PresetDecl,
  SegmentDecl,
  SegmentNode,
  VariableDecl,
} from "./dsl-types.js";
import { collectSegmentNames } from "./layout-ops.js";
import { presetByName, presetNames, presetRoot } from "./presets.js";
import {
  EDIT_MODE_GATE,
  EDIT_NS,
  EDIT_TOGGLE_ACTION,
} from "./loader/edit-mode.js";
import { GROUP_NS } from "./loader/layout.js";
import {
  menuActionName,
  menuMember,
  menuPageKey,
  menuStateKey,
  MENU_NS,
} from "./menu-keys.js";
import {
  DISCLOSURE_CLOSED,
  disclosureCycleAction,
  disclosureStateVar,
} from "./disclosure.js";

// [LAW:one-source-of-truth] group/menu-synthesized segments (`groups.`/
// `menus.`) and edit mode's own trigger/chrome (`edit.`) are structural —
// removing one via `-` would strand its sibling artifacts (a toggle segment
// with no body, a menu with no host), and offering one back via `+` would
// insert a bare ref with none of the synthesis that made it work. Ordinary
// content segments only.
function isChromeExempt(name: string): boolean {
  return (
    name.startsWith(EDIT_NS) ||
    name.startsWith(MENU_NS) ||
    name.startsWith(GROUP_NS)
  );
}

// [LAW:types-are-the-program] Collapse an arbitrary name to a template-
// identifier-safe fragment — the SAME shape menu-keys.ts's `ident` enforces,
// reimplemented here rather than imported (menu-keys.ts's copy is
// module-private) since both need only the one rule: alphanumerics survive,
// everything else collapses to `_`.
function ident(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_");
}

// [LAW:one-source-of-truth] Every synthesized decl this pass produces, keyed
// by its final name — one accumulator threaded through every preset's splice
// so cross-preset names (disambiguated by `presetIdent`) can never collide.
interface ChromeArtifacts {
  readonly variables: Record<string, VariableDecl>;
  readonly actions: Record<string, ActionDeclType>;
  readonly segments: Record<string, SegmentDecl>;
}

// [LAW:one-source-of-truth] The domain name a preset's `+` pickers range —
// computed once per preset (declared segments minus the ones already present
// in ITS current tree) and consumed two ways: here (by name, for every
// insertSegmentFrom action this preset's splice synthesizes) and by
// registerDslConfig/deriveConfigActionValidators (which call
// `addableSegmentDomains` directly to populate `perConfigDomains` before
// resolving `from`). Both read the SAME string shape so a synthesized
// action's domain name always resolves.
export function addableDomainName(presetName: string): string {
  return `${EDIT_NS}addable.${presetName}`;
}

// [LAW:one-source-of-truth] THE per-preset "what can `+` offer here" set:
// every declared, non-exempt segment name minus the ones already present
// anywhere in that preset's CURRENT (merged, rootOps-replayed) tree. Exported
// so render.ts's registerDslConfig and config-validators.ts's
// deriveConfigActionValidators — the two sites that resolve `from` domains —
// merge this into `perConfigDomainsFor`'s map without each re-deriving it
// [LAW:locality-or-seam]; option-domain.ts itself stays untouched (its
// `perConfigDomainsFor` deliberately never imports dsl-types.ts — see that
// file's own header — so a third per-preset domain merges at the two call
// sites instead of inside it).
export function addableSegmentDomains(
  config: DslConfig,
): ReadonlyMap<string, readonly string[]> {
  const declared = Object.keys(config.segments).filter(
    (n) => !isChromeExempt(n),
  );
  const domains = new Map<string, readonly string[]>();
  for (const name of presetNames(config.presets)) {
    const { node } = presetRoot(config, name);
    const present = collectSegmentNames(node);
    domains.set(
      addableDomainName(name),
      declared.filter((n) => !present.has(n)),
    );
  }
  return domains;
}

// Synthesize the `-` affordance for one segment instance: a literal
// `removeSegment` action plus the segment that hosts its `{{ action }}`.
function removeChrome(
  presetIdent: string,
  rootOpsKey: string,
  segName: string,
  artifacts: ChromeArtifacts,
): SegmentNode {
  const actionName = `${EDIT_NS}${presetIdent}.remove.${ident(segName)}`;
  const chromeSegName = `${EDIT_NS}${presetIdent}.removeSeg.${ident(segName)}`;
  artifacts.actions[actionName] = {
    persist: rootOpsKey,
    removeSegment: segName,
  };
  artifacts.segments[chromeSegName] = {
    template: `{{ action "${actionName}" "-" }}`,
    when: EDIT_MODE_GATE,
  };
  return { kind: "segment", name: chromeSegName };
}

// Synthesize the `+` affordance for one gap: an `insertSegmentFrom` action
// over this preset's addable domain, plus a segment hosting `{{ menu }}` over
// it. The menu's own disclosure (open state, page cursor, toggle action) is
// synthesized here by calling the SAME pure functions menu-synth.ts's
// file-parse-time pass calls — this pass runs too late to piggyback on that
// pass directly (it needs post-merge/post-rootOps data menu-synth.ts's
// per-file timing does not have), so parity is achieved by sharing the
// functions, not by re-deriving the shape.
function insertChrome(
  presetIdent: string,
  rootOpsKey: string,
  posIdent: string,
  domainName: OptionDomain,
  anchor: string,
  relation: "before" | "after",
  artifacts: ChromeArtifacts,
): SegmentNode {
  const applyName = `${EDIT_NS}${presetIdent}.insert.${posIdent}`;
  const chromeSegName = `${EDIT_NS}${presetIdent}.insertSeg.${posIdent}`;
  artifacts.actions[applyName] = {
    persist: rootOpsKey,
    insertSegmentFrom: domainName,
    anchor,
    relation,
  };

  const member = menuMember(applyName);
  const stateKey = menuStateKey(chromeSegName, applyName, undefined);
  const pageKey = menuPageKey(stateKey);
  const identity = menuActionName(stateKey, member);
  artifacts.variables[stateKey] = disclosureStateVar(
    stateKey,
    DISCLOSURE_CLOSED,
  );
  artifacts.variables[pageKey] = { kind: "state", key: pageKey, default: "0" };
  artifacts.actions[identity] = disclosureCycleAction(stateKey, member);
  artifacts.actions[pageKey] = { set: pageKey, int: true };

  artifacts.segments[chromeSegName] = {
    template: `+{{ menu "${applyName}" }}`,
    when: EDIT_MODE_GATE,
  };
  return { kind: "segment", name: chromeSegName };
}

// [LAW:dataflow-not-control-flow] One recursive splice: a container's
// non-exempt segment children get a `+` before and a `-` after (so N
// consecutive segments read `+ [seg1 -] + [seg2 -] + [seg3 -] +` — N+1 insert
// points, N remove points); a container child recurses; an exempt segment
// (a group toggle, a menu host, edit mode's own chrome) passes through
// untouched. `posCounter` is threaded by reference so position identifiers
// stay unique across the WHOLE preset tree, not just one container.
function spliceContainer(
  node: ContainerNode,
  presetIdent: string,
  rootOpsKey: string,
  domainName: OptionDomain,
  artifacts: ChromeArtifacts,
  posCounter: { n: number },
): ContainerNode {
  const children: LayoutNode[] = [];
  for (const child of node.children) {
    if (child.kind === "container") {
      children.push(
        spliceContainer(
          child,
          presetIdent,
          rootOpsKey,
          domainName,
          artifacts,
          posCounter,
        ),
      );
      continue;
    }
    if (isChromeExempt(child.name)) {
      children.push(child);
      continue;
    }
    children.push(
      insertChrome(
        presetIdent,
        rootOpsKey,
        String(posCounter.n++),
        domainName,
        child.name,
        "before",
        artifacts,
      ),
    );
    children.push(child);
    children.push(removeChrome(presetIdent, rootOpsKey, child.name, artifacts));
  }
  const last = node.children[node.children.length - 1];
  if (
    last !== undefined &&
    last.kind === "segment" &&
    !isChromeExempt(last.name)
  ) {
    children.push(
      insertChrome(
        presetIdent,
        rootOpsKey,
        String(posCounter.n++),
        domainName,
        last.name,
        "after",
        artifacts,
      ),
    );
  }
  return { ...node, children };
}

// One preset's chrome-spliced root. A bare-segment root (the A-grammar
// collapses a single top-level segment ref to `{ kind: "segment", name }`
// with no enclosing container) is wrapped in a synthetic horizontal
// container for splicing purposes — the wrap becomes the real returned root,
// which is exactly right: a lone segment needs a `+` on each side too.
function spliceEditChromeForPreset(
  config: DslConfig,
  presetName: string,
  artifacts: ChromeArtifacts,
): LayoutNode {
  const { node } = presetRoot(config, presetName);
  const rootOpsKey = `presets.${presetName}.rootOps`;
  const domainName = addableDomainName(presetName);
  const presetIdent = ident(presetName);
  const posCounter = { n: 0 };
  const container: ContainerNode =
    node.kind === "container"
      ? node
      : { kind: "container", direction: "horizontal", children: [node] };
  return spliceContainer(
    container,
    presetIdent,
    rootOpsKey,
    domainName,
    artifacts,
    posCounter,
  );
}

// [LAW:single-enforcer] THE synthesis entry point, called once from
// validateConfig after cross-ref/cycle checks pass. Every declared preset
// (the floor "default" included — presetNames/presetByName/presetRoot
// already treat it uniformly) gets an explicit `presets[name].root` carrying
// its spliced tree; `config.root` itself is left untouched (presetRoot falls
// back to it only when a preset declares no root of its own, and every name
// now does). The synthesized variables/actions/segments merge additively —
// nothing here can collide with user data, since every name it mints lives
// under the `edit.`/`menus.` namespaces `synthesizeEditModeToggle` and
// `synthesizeMenuDecls` already reserve unconditionally at parse time.
export function synthesizeEditChrome(config: DslConfig): DslConfig {
  // [LAW:carrying-cost] Demand-driven, mirroring synthesizeEditModeToggle's
  // own gate: `edit.toggle` exists in the merged config iff SOME file's
  // Phase A synthesis fired (iff some segment referenced it), which iff some
  // author actually placed an edit-mode trigger. A config that never opted
  // in gets back the identical config, untouched — no extra segments,
  // actions, or variables, and critically no NEW `set`/`state` surface that
  // would force session.id onto an otherwise fully static bar.
  if (!(EDIT_TOGGLE_ACTION in config.actions)) return config;
  const artifacts: ChromeArtifacts = {
    variables: {},
    actions: {},
    segments: {},
  };
  const presets: Record<string, PresetDecl> = { ...config.presets };
  for (const name of presetNames(config.presets)) {
    const splicedRoot = spliceEditChromeForPreset(config, name, artifacts);
    presets[name] = {
      ...presetByName(config.presets, name),
      root: splicedRoot,
    };
  }
  return {
    ...config,
    variables: { ...config.variables, ...artifacts.variables },
    actions: { ...config.actions, ...artifacts.actions },
    segments: { ...config.segments, ...artifacts.segments },
    presets,
  };
}
