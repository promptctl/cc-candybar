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
import { presetRootOpsKey } from "./loader/persist-target.js";
import { ident } from "./ident.js";
import {
  EDIT_MODE_GATE,
  EDIT_MODE_REF,
  EDIT_NS,
  EDIT_TOGGLE_ACTION,
} from "./loader/edit-mode.js";
import { declareHelp, type HelpDisclosure } from "./help.js";
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
} from "./disclosure.js";

// [LAW:dataflow-not-control-flow] brandon-layout-edit-2gc.5's diagnostic gate
// — read the SAME way EDIT_MODE_GATE is: a bare boolean input var, false
// only on the literal text "false" (evaluateWhen's documented contract).
// `.preset.customized` is a per-render payload fact (presetIsCustomized over
// entry.state.presetRootOps for whichever preset is ACTIVE), not config-time
// knowledge, so the banner below is spliced UNCONDITIONALLY for every
// preset — same shape, every reload — and this predicate is what decides
// whether it's visible, never a branch in this synthesis pass.
// [LAW:one-source-of-truth] Exported: test/helpers/ambient-chrome.ts filters this
// ensured name out of "what did the AUTHOR declare" assertions and must read the
// same string, never a second copy that a rename here would leave behind.
export const PRESET_CUSTOMIZED_VAR = "preset.customized";
const PRESET_CUSTOMIZED_GATE = `{{ .${PRESET_CUSTOMIZED_VAR} }}`;

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
    name.startsWith(GROUP_NS) ||
    // The global settings menu is the entry point edit mode is REACHED from
    // (candybar-settings-ui-aok.1) — offering a `-` beside it would let one
    // click delete the door back in, the self-lockout the `toolbar` trigger's
    // placement was chosen to avoid. Structural, like the three above it.
    name.startsWith(SETTINGS_NS)
  );
}

// [LAW:one-source-of-truth] Every synthesized decl this pass produces, keyed
// by its final name — one accumulator threaded through every preset's splice
// so cross-preset names (disambiguated by `presetIdent`) can never collide.
interface ChromeArtifacts {
  readonly variables: Record<string, VariableDecl>;
  // [LAW:no-silent-failure] Declarations this synthesis DEPENDS on rather than
  // OWNS: merged UNDER the config so a user's own declaration of the same name
  // wins, unlike `variables` above, which lives in a reserved namespace no user
  // may write and therefore merges over.
  readonly ensured: Record<string, VariableDecl>;
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

  // The `+` IS the trigger — no appended arrow (candybar-settings-ui-aok.4).
  // Beside a `-` that means something else entirely, a ▸ read as part of the
  // affordance rather than as a disclosure hint, so the trigger names the ACTION
  // its click performs instead: `+` inserts here, `✕` closes what `+` opened —
  // the same glyph, and the same effect, as the body's own close cell.
  //
  // [LAW:no-silent-failure] It is deliberately NOT one static display. A preset
  // has N insertion points whose rendered rows are byte-identical, and their
  // dropped bodies are identical too — so with no per-state display, an open `+`
  // is indistinguishable from the two beside it and the bar silently stops
  // answering "which one did I open". The tint that marks other open menus
  // (node-registry's `drops.length > 0`) cannot answer it either: this segment
  // declares no bg, so there is nothing to tint.
  artifacts.segments[chromeSegName] = {
    template: `{{ menu "${applyName}" "+" "${DISCLOSURE_GLYPH_CLOSE}" }}`,
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
  // [LAW:one-source-of-truth] The trailing `+`'s position is "after the last
  // CONTENT segment", not "after the last child". Those coincided until a
  // synthesis started appending exempt chrome (the global settings menu,
  // candybar-settings-ui-aok.1) to a row's end, at which point reading the last
  // child silently dropped the row's final insert point — N segments offering
  // only N insert points instead of N+1.
  const lastContent = node.children.reduce(
    (idx, child, i) =>
      child.kind === "segment" && !isChromeExempt(child.name) ? i : idx,
    -1,
  );
  for (const [i, child] of node.children.entries()) {
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
    if (i === lastContent) {
      children.push(
        insertChrome(
          presetIdent,
          rootOpsKey,
          String(posCounter.n++),
          domainName,
          child.name,
          "after",
          artifacts,
        ),
      );
    }
  }
  return { ...node, children };
}

// brandon-layout-edit-2gc.5's other per-preset affordance: a `+`/`-` sibling
// that isn't about ONE gap but about the preset's rootOps log as a whole —
// synthesized the SAME way (one reset action targeting this preset's exact
// `persist` key, one segment hosting `{{ action }}`), UNCONDITIONALLY, with
// visibility carried entirely by PRESET_CUSTOMIZED_GATE
// [LAW:dataflow-not-control-flow]. It gets its own ROW (not a slot in the
// row-interleaved chrome spliceContainer builds) because it is not bound to any
// one segment gap — it is a fact about the whole tree — visible or not by the
// SAME `when` every other synthesized affordance here already uses.
//
// candybar-settings-ui-aok.6 hangs edit mode's `(?)` off the same content — its
// BODY is a per-preset row on the same footing as the banner, so this function
// now brackets the content rather than only preceding it, which is what its name
// says and why it is no longer "prepend". Its TRIGGER is not a row; see
// withTrailingCell.
function wrapWithPresetRows(
  splicedRoot: LayoutNode,
  presetName: string,
  presetIdent: string,
  rootOpsKey: string,
  artifacts: ChromeArtifacts,
  help: HelpDisclosure,
): LayoutNode {
  const actionName = `${EDIT_NS}${presetIdent}.resetLayout`;
  const chromeSegName = `${EDIT_NS}${presetIdent}.customized`;
  // [LAW:no-silent-failure] `reset` clears `rootOpsKey` outright, restoring
  // presetRoot's own fallback (the config's literal, hand-authored root) on
  // the next reload — the exact undo the ticket's guardrail asked for.
  // `rootOpsKey` is gated the SAME way every other `presets.<name>.rootOps`
  // target is (deriveConfigActionValidators), and is ALWAYS a registered
  // key — config-validators.ts's presetRootOpsContributions registers it
  // for every declared preset UNCONDITIONALLY, specifically so a preset
  // edited down to zero non-exempt segments (no removeChrome/insertChrome
  // persist actions left to register it) doesn't orphan this exact click.
  artifacts.actions[actionName] = { reset: rootOpsKey };
  // [LAW:one-source-of-truth] The banner reads `.preset.customized`, so THIS
  // pass is what requires that variable — not whichever config happens to
  // declare it. The bundled default does, which is why the dependency stayed
  // invisible until the global settings menu made edit mode reachable from
  // configs that never declared it, and the missing field surfaced as a ⚠ on
  // the bar. Ensured, never overridden: a user declaration of the same name
  // wins (see the merge in synthesizeEditChrome), so this only supplies the
  // floor the synthesis itself depends on.
  artifacts.ensured[PRESET_CUSTOMIZED_VAR] = {
    kind: "input",
    path: PRESET_CUSTOMIZED_VAR,
    type: "boolean",
    default: false,
  };
  const label = escapeTemplateLiteral(presetName);
  artifacts.segments[chromeSegName] = {
    template: `{{ action "${actionName}" "↺ ${label} customized" }}`,
    when: PRESET_CUSTOMIZED_GATE,
  };
  // [LAW:no-silent-failure] A preset's root may carry its OWN top-level
  // `when` (the A-grammar's container schemas all permit one) — an author
  // gating the whole preset behind a condition. `spliceContainer` preserves
  // that onto `splicedRoot` via its `{...node, children}` spread, but this
  // new OUTER wrapper is a brand-new node with no `when` of its own; without
  // carrying it up, the reset banner would render even when the author's
  // own condition is false, leaking past a gate they wrote.
  return {
    kind: "container",
    direction: "vertical",
    children: [
      { kind: "segment", name: chromeSegName },
      withTrailingCell(splicedRoot, help.trigger),
      // The body is a ROW of its own, and only while the disclosure is open —
      // dropping BELOW the row that revealed it, like every other disclosure
      // body in this codebase.
      help.body,
    ],
    ...(splicedRoot.when !== undefined && { when: splicedRoot.when }),
  };
}

// [LAW:one-source-of-truth] `HelpDisclosure.trigger` is a CELL, and its contract
// is that the caller joins it to a row it ALREADY HAS — the settings menu pushes
// it into the row holding `persist?`. Edit mode's rows are the ones
// spliceContainer just built, so the trigger joins the last of them. Two
// constraints pin that placement and nothing else satisfies both:
//
//  - Closed help must cost no LINE. A trigger given its own vertical slot is a
//    permanent row for the whole time edit mode is on, since a trigger's `when`
//    is its host surface's, never its own open state (a trigger you must open in
//    order to see could never be opened).
//  - Closed help must cost no COLOUR. The hue cursor (src/dsl/render.ts:696)
//    advances in pre-order over every segment leaf — VISIBLE OR NOT, so that
//    toggling a disclosure never recolours the bar — which means a leaf inserted
//    AHEAD of the content shifts the hue index of everything after it. An
//    earlier draft put the `(?)` first and recoloured every cell of the bundled
//    default (status row 33;41;59 → 49;36;52) with edit mode still OFF. Trailing
//    the last row is the one position that moves no other leaf.
//
// Those two together disqualify the reset-banner row, which sits above the
// content. The trigger does inherit its host row's own `when`, which is what
// riding a row means: a preset that gates its last row hides that row's `+`/`-`
// affordances along with the `(?)` explaining them.
//
// [LAW:dataflow-not-control-flow] Total over the three node shapes with no
// guard: a vertical container's rows are its children, so recurse into the last;
// a horizontal container IS a row, so append; a segment is a row of one that
// cannot hold a second cell, so pair it into one. An empty container has no last
// child and appends, which is the same answer.
function withTrailingCell(node: LayoutNode, cell: LayoutNode): LayoutNode {
  if (node.kind === "segment") {
    return {
      kind: "container",
      direction: "horizontal",
      children: [node, cell],
    };
  }
  const last = node.children.at(-1);
  if (node.direction === "horizontal" || last === undefined) {
    return { ...node, children: [...node.children, cell] };
  }
  return {
    ...node,
    children: [...node.children.slice(0, -1), withTrailingCell(last, cell)],
  };
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
  help: HelpDisclosure,
): LayoutNode {
  const { node } = presetRoot(config, presetName);
  const rootOpsKey = presetRootOpsKey(presetName);
  const domainName = addableDomainName(presetName);
  const presetIdent = ident(presetName);
  const posCounter = { n: 0 };
  // [LAW:no-silent-failure] The bare-segment-root case (the A-grammar's
  // `{ seg, when }` shorthand is a legal PresetDecl.root) carries its OWN
  // `when` onto this synthetic wrapper too — wrapWithPresetRows's own
  // when-carry-up reads `splicedRoot.when`, which is this wrapper's `when`
  // once spliceContainer's `{...node, children}` passes it through
  // unchanged; without copying it here, a bare-segment preset root's own
  // gate would never reach that carry-up at all, leaking the reset banner
  // past it exactly like the container case did before that fix.
  const container: ContainerNode =
    node.kind === "container"
      ? node
      : {
          kind: "container",
          direction: "horizontal",
          children: [node],
          ...(node.when !== undefined && { when: node.when }),
        };
  const spliced = spliceContainer(
    container,
    presetIdent,
    rootOpsKey,
    domainName,
    artifacts,
    posCounter,
  );
  return wrapWithPresetRows(
    spliced,
    presetName,
    presetIdent,
    rootOpsKey,
    artifacts,
    help,
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
    ensured: {},
    actions: {},
    segments: {},
  };
  // [LAW:one-source-of-truth] Edit mode's `(?)` is minted ONCE and merely
  // REFERENCED from every preset root — the same move the settings menu makes
  // with its anchor, and for the same reason: one disclosure means one open
  // state, so switching presets cannot land you beside a second `(?)` that
  // disagrees about whether help is showing. The text is identical for every
  // preset because what `+` and `-` do is a fact about edit mode, not about a
  // layout.
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
