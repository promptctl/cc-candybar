// [LAW:one-source-of-truth] The LOWERING that turns "edit mode is a session
// toggle" into "+/- affordances interleaved with a row's segments", with no
// render-walk branch [LAW:dataflow-not-control-flow]. It runs after merge
// because it is DERIVED from the tree. [LAW:single-enforcer] Existing primitives.

import type { ActionDecl as ActionDeclType, OptionDomain } from "./action.js";
import {
  mapOpens,
  type ContainerNode,
  type DslConfig,
  type LayoutNode,
  type PresetDecl,
  type SegmentDecl,
  type SegmentNode,
  type VariableDecl,
} from "./dsl-types.js";
import { collectSegmentNames } from "./layout-ops.js";
import { presetByName, presetNames, presetRoot } from "./presets.js";
import { presetRootKey } from "./loader/persist-target.js";
import { ident } from "./ident.js";
import {
  EDIT_MODE_GATE,
  EDIT_MODE_REF,
  EDIT_NS,
  EDIT_TOGGLE_ACTION,
} from "./loader/edit-mode.js";
import { declareHelp } from "./help.js";
import { EDIT_MODE_HELP } from "../help-text.js";
import { GROUP_NS } from "./loader/layout.js";
import { SETTINGS_NS } from "./settings-menu.js";
import {
  menuActionName,
  menuMember,
  menuPageKey,
  menuStateKey,
  MENU_NS,
} from "./menu-keys.js";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSE,
  escapeTemplateLiteral,
  disclosureCycleAction,
  disclosureStateVar,
  disclosureTerm,
} from "./disclosure.js";

// [LAW:dataflow-not-control-flow] `.preset.customized` is a per-render fact, so
// the banner splices UNCONDITIONALLY and this gate alone decides visibility.
// [LAW:one-type-per-behavior] Edit mode is conjoined because "customized" is the
// ordinary state of a hand-written config, where the banner would otherwise sit
// permanently as a one-click deletion of the author's own layout.
export const PRESET_CUSTOMIZED_VAR = "preset.customized";
const CUSTOMIZED_BANNER_GATE = `{{ and ${disclosureTerm(EDIT_MODE_REF)} .${PRESET_CUSTOMIZED_VAR} }}`;

// [LAW:one-source-of-truth] Synthesized segments are structural: `-` strands
// sibling artifacts, `+` re-inserts a ref with none of the synthesis.
function isChromeExempt(name: string): boolean {
  return (
    name.startsWith(EDIT_NS) ||
    name.startsWith(MENU_NS) ||
    name.startsWith(GROUP_NS) ||
    name.startsWith(SETTINGS_NS)
  );
}

interface ChromeArtifacts {
  readonly variables: Record<string, VariableDecl>;
  // [LAW:no-silent-failure] Declarations this synthesis DEPENDS on rather than
  // OWNS: merged UNDER the config, so a user's own declaration wins.
  readonly ensured: Record<string, VariableDecl>;
  readonly actions: Record<string, ActionDeclType>;
  readonly segments: Record<string, SegmentDecl>;
}

export function addableDomainName(presetName: string): string {
  return `${EDIT_NS}addable.${presetName}`;
}

// [LAW:one-source-of-truth] THE per-preset "what can `+` offer here" set.
// [LAW:locality-or-seam] Exported so the two sites resolving `from` domains
// merge it rather than re-derive it; option-domain.ts stays free of dsl-types.
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

function removeChrome(
  presetIdent: string,
  rootKey: string,
  segName: string,
  artifacts: ChromeArtifacts,
): SegmentNode {
  const actionName = `${EDIT_NS}${presetIdent}.remove.${ident(segName)}`;
  const chromeSegName = `${EDIT_NS}${presetIdent}.removeSeg.${ident(segName)}`;
  artifacts.actions[actionName] = {
    persist: rootKey,
    removeSegment: segName,
  };
  artifacts.segments[chromeSegName] = {
    template: `{{ action "${actionName}" "-" }}`,
    when: EDIT_MODE_GATE,
  };
  return { kind: "segment", name: chromeSegName };
}

// The disclosure is built by calling the SAME pure functions the parse-time menu
// pass calls: too late to piggyback on it, so parity comes from sharing them.
function insertChrome(
  presetIdent: string,
  rootKey: string,
  posIdent: string,
  domainName: OptionDomain,
  anchor: string,
  relation: "before" | "after",
  artifacts: ChromeArtifacts,
): SegmentNode {
  const applyName = `${EDIT_NS}${presetIdent}.insert.${posIdent}`;
  const chromeSegName = `${EDIT_NS}${presetIdent}.insertSeg.${posIdent}`;
  artifacts.actions[applyName] = {
    persist: rootKey,
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

  // [LAW:no-silent-failure] Two displays, not one static glyph: a preset's N
  // insertion points render byte-identically, and "which one did I open" must
  // not rest on a tint the terminal's colour depth may flatten.
  artifacts.segments[chromeSegName] = {
    template: `{{ menu "${applyName}" "+" "${DISCLOSURE_GLYPH_CLOSE}" }}`,
    when: EDIT_MODE_GATE,
  };
  return { kind: "segment", name: chromeSegName };
}

// [LAW:dataflow-not-control-flow] An exempt segment passes through untouched,
// but the disclosure BODY it hangs still recurses. `posCounter` is by reference,
// so position ids stay unique across the whole preset tree.
function spliceContainer(
  node: ContainerNode,
  presetIdent: string,
  rootKey: string,
  domainName: OptionDomain,
  artifacts: ChromeArtifacts,
  posCounter: { n: number },
): ContainerNode {
  const children: LayoutNode[] = [];
  // [LAW:one-source-of-truth] After the last CONTENT segment, not the last
  // child: appended exempt chrome would silently eat the row's final `+`.
  const lastContent = node.children.reduce(
    (idx, child, i) =>
      child.kind === "segment" && !isChromeExempt(child.name) ? i : idx,
    -1,
  );
  const splice = (body: ContainerNode): ContainerNode =>
    spliceContainer(
      body,
      presetIdent,
      rootKey,
      domainName,
      artifacts,
      posCounter,
    );
  for (const [i, child] of node.children.entries()) {
    if (child.kind === "container") {
      children.push(splice(child));
      continue;
    }
    const spliced = mapOpens(child, splice);
    if (isChromeExempt(child.name)) {
      children.push(spliced);
      continue;
    }
    const cells: LayoutNode[] = [
      insertChrome(
        presetIdent,
        rootKey,
        String(posCounter.n++),
        domainName,
        child.name,
        "before",
        artifacts,
      ),
      spliced,
      removeChrome(presetIdent, rootKey, child.name, artifacts),
      ...(i === lastContent
        ? [
            insertChrome(
              presetIdent,
              rootKey,
              String(posCounter.n++),
              domainName,
              child.name,
              "after",
              artifacts,
            ),
          ]
        : []),
    ];
    // [LAW:one-type-per-behavior] A VERTICAL container's segment child is a
    // one-cell row; its chrome joins it, under the row's own gate.
    children.push(
      ...(node.direction === "vertical"
        ? [
            {
              kind: "container" as const,
              direction: "horizontal" as const,
              children: cells,
              ...(child.when !== undefined && { when: child.when }),
            },
          ]
        : cells),
    );
  }
  return { ...node, children };
}

// [LAW:dataflow-not-control-flow] An affordance about the authored root as a
// whole, so it gets its own ROW and its visibility is carried by the gate.
function wrapWithPresetRows(
  splicedRoot: LayoutNode,
  presetName: string,
  presetIdent: string,
  rootKey: string,
  artifacts: ChromeArtifacts,
  help: SegmentNode,
): LayoutNode {
  const actionName = `${EDIT_NS}${presetIdent}.resetLayout`;
  const chromeSegName = `${EDIT_NS}${presetIdent}.customized`;
  // [LAW:no-silent-failure] `rootKey` is registered UNCONDITIONALLY, so a preset
  // edited down to zero segments cannot orphan this click.
  artifacts.actions[actionName] = { reset: rootKey };
  // [LAW:one-source-of-truth] THIS pass requires it; ensured, never overridden.
  artifacts.ensured[PRESET_CUSTOMIZED_VAR] = {
    kind: "input",
    path: PRESET_CUSTOMIZED_VAR,
    type: "boolean",
    default: false,
  };
  const label = escapeTemplateLiteral(presetName);
  artifacts.segments[chromeSegName] = {
    template: `{{ action "${actionName}" "↺ ${label} customized" }}`,
    when: CUSTOMIZED_BANNER_GATE,
  };
  // [LAW:no-silent-failure] A preset root may carry its own top-level `when`, so
  // this new outer wrapper must carry it up or the banner leaks past that gate.
  return {
    kind: "container",
    direction: "vertical",
    children: [
      { kind: "segment", name: chromeSegName },
      withTrailingCell(splicedRoot, help),
    ],
    ...(splicedRoot.when !== undefined && { when: splicedRoot.when }),
  };
}

// [LAW:one-source-of-truth] The `(?)` is a CELL joined to a row the caller
// already has. In priority order: visible exactly when EDIT MODE is — so the
// descent never enters a `when`-bearing container, whose gate would silently
// become the trigger's — then no moved addresses, then no extra closed line.
// [LAW:dataflow-not-control-flow] Total over the node shapes, with no guard.
function withTrailingCell(node: LayoutNode, cell: LayoutNode): LayoutNode {
  if (node.kind === "segment") {
    return {
      kind: "container",
      direction: "horizontal",
      children: [node, cell],
    };
  }
  const last = node.children.at(-1);
  if (
    node.direction === "vertical" &&
    last !== undefined &&
    (last.kind === "segment" || last.when === undefined)
  ) {
    return {
      ...node,
      children: [...node.children.slice(0, -1), withTrailingCell(last, cell)],
    };
  }
  return { ...node, children: [...node.children, cell] };
}

function spliceEditChromeForPreset(
  config: DslConfig,
  presetName: string,
  artifacts: ChromeArtifacts,
  help: SegmentNode,
): LayoutNode {
  const { node } = presetRoot(config, presetName);
  const rootKey = presetRootKey(presetName);
  const domainName = addableDomainName(presetName);
  const presetIdent = ident(presetName);
  const posCounter = { n: 0 };
  const spliced = spliceContainer(
    node,
    presetIdent,
    rootKey,
    domainName,
    artifacts,
    posCounter,
  );
  return wrapWithPresetRows(
    spliced,
    presetName,
    presetIdent,
    rootKey,
    artifacts,
    help,
  );
}

// [LAW:single-enforcer] THE synthesis entry point, called once from
// validateConfig; every minted name lives under a reserved namespace.
export function synthesizeEditChrome(config: DslConfig): DslConfig {
  // [LAW:carrying-cost] Demand-driven: a config that never placed an edit-mode
  // trigger gets the identical config back, forcing no session.id onto a static bar.
  if (!(EDIT_TOGGLE_ACTION in config.actions)) return config;
  const artifacts: ChromeArtifacts = {
    variables: {},
    ensured: {},
    actions: {},
    segments: {},
  };
  // [LAW:one-source-of-truth] Minted ONCE and merely REFERENCED per preset, so
  // switching presets cannot land you beside a second, disagreeing `(?)`.
  const help = declareHelp(
    `${EDIT_NS}help`,
    EDIT_MODE_HELP,
    [EDIT_MODE_REF],
    artifacts,
  );
  const presets: Record<string, PresetDecl> = { ...config.presets };
  for (const name of presetNames(config.presets)) {
    const splicedRoot = spliceEditChromeForPreset(
      config,
      name,
      artifacts,
      help,
    );
    presets[name] = {
      ...presetByName(config.presets, name),
      root: splicedRoot,
    };
  }
  return {
    ...config,
    variables: {
      ...artifacts.ensured,
      ...config.variables,
      ...artifacts.variables,
    },
    actions: { ...config.actions, ...artifacts.actions },
    segments: { ...config.segments, ...artifacts.segments },
    presets,
  };
}
