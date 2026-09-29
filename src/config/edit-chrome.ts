// [LAW:one-source-of-truth] brandon-layout-edit-2gc.3's CHROME half — the
// LOWERING that turns "edit mode is a session toggle" into "each row's
// segments render interleaved with +/- affordances" without a render-walk
// branch [LAW:dataflow-not-control-flow]. Follows the SAME move `kind:
// "group"` sugar makes (src/config/loader/layout.ts): one pass produces a NEW
// tree with synthesized nodes spliced in, each gated by an ordinary `when` —
// the walk that renders it learns nothing new. The difference from group
// sugar is WHEN this can run: a group is authored data, lowered per file
// before merge; edit chrome is DERIVED from which segments are actually in
// the tree, which is only known after merge and preset-root resolution. So
// this runs from validateConfig, on the fully resolved
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

import { synthesisInputs } from "./synthesis-inputs.js";
import type { ActionDecl as ActionDeclType, OptionDomain } from "./action.js";
import {
  mapOpens,
  placementId,
  type ContainerNode,
  type DisclosureRef,
  type DslConfig,
  type LayoutNode,
  type PresetDecl,
  type SegmentDecl,
  type SegmentNode,
  type VariableDecl,
} from "./dsl-types.js";
import { presetByName, presetNames, presetRoot } from "./presets.js";
import type { ResolvedDomain } from "./option-domain.js";
import { presetRootKey } from "./loader/persist-target.js";
import { ident } from "./ident.js";
import {
  EDIT_MODE_GATE,
  EDIT_MODE_REF,
  EDIT_TOGGLE_ACTION,
} from "./loader/edit-mode.js";
import { EDIT_NS, isReservedName } from "./loader/reserved-namespace.js";
import { declareHelp } from "./help.js";
import { TEXT_MIN_CONTRAST } from "../themes/decor.js";
import { EDIT_MODE_HELP } from "../help-text.js";
import {
  menuActionName,
  menuMember,
  menuPageKey,
  menuStateKey,
} from "./menu-keys.js";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSE,
  escapeTemplateLiteral,
  disclosureCycleAction,
  disclosureStateVar,
  disclosureTerm,
  disclosureTrigger,
} from "./disclosure.js";

// [LAW:one-source-of-truth] Edit mode shows the ARRANGEMENT: every content
// cell reads as its segment's name, so a segment whose own `when` hides it
// (no ssh session, an idle cache timer) is still there to move or remove —
// its `-` would otherwise sit beside nothing. `☐ live` swaps the names back
// for the live output. It is a binary toggle over one SessionState key, which
// is what a disclosure ref already names, so both gates below derive from the
// one term spelling rather than a second `eq`.
export const EDIT_LIVE_KEY = `${EDIT_NS}live`;
// The toggle's text per state, names view (closed) first.
export const EDIT_LIVE_DISPLAY = ["☐ live", "☑ live"] as const;
export const EDIT_DONE_SEG = `${EDIT_NS}done`;
export const REMOVE_GLYPH = "🚫";
export const ADD_GLYPH = "✚";
const EDIT_LIVE_REF: DisclosureRef = {
  variable: EDIT_LIVE_KEY,
  key: EDIT_LIVE_KEY,
  member: "open",
};
const NAMES_VIEW = `and ${disclosureTerm(EDIT_MODE_REF)} (not ${disclosureTerm(EDIT_LIVE_REF)})`;
const LABEL_GATE = `{{ ${NAMES_VIEW} }}`;

// [LAW:dataflow-not-control-flow] The names view decides a gate outright;
// every other view hands it to the author's own `when`, evaluated exactly as
// it was. A `when` is a whole template body, so it nests verbatim in the
// `else` arm — no second node is needed to conjoin two predicates. A content
// cell holds its label AND its live segment, always: in the names view the
// segment is `false` and the label shows, and an authored container is `true`
// so nothing placed hides behind a gate; outside it the label is false and
// the bar renders exactly what it renders without edit mode.
function inNamesView(verdict: "true" | "false", when: string): string {
  return `{{ if ${NAMES_VIEW} }}${verdict}{{ else }}${when}{{ end }}`;
}

// [LAW:dataflow-not-control-flow] brandon-layout-edit-2gc.5's diagnostic gate.
// `.preset.customized` is a per-render payload fact (does the config FILE
// author a root for whichever preset is ACTIVE — entry.state.authoredRoots),
// not config-time knowledge, so the banner below is spliced UNCONDITIONALLY
// for every preset — same shape, every reload — and this predicate is what
// decides whether it's visible, never a branch in this synthesis pass.
//
// [LAW:one-type-per-behavior] The banner is an edit affordance of the same
// class as `-`/`+` — one click rewrites the file's root — so it shows under
// the same condition they do (edit mode open) AND only when it has something
// to reset. Under candybar-config-dqe "customized" means "the file authors a
// root", the ordinary state of every hand-written config; a banner gated on
// that alone would sit permanently on such bars, outside edit mode, as a
// one-click deletion of the author's own layout. The edit-mode term is
// disclosureTerm over the SAME ref every other chrome gate derives from; the
// customized term is the bare boolean input var, false only on the literal
// text "false" (evaluateWhen's documented contract), and `and` yields the
// last argument when every term is truthy — so the conjunction reads back
// exactly as the boolean does.
// [LAW:one-source-of-truth] Exported: test/helpers/ambient-chrome.ts filters this
// ensured name out of "what did the AUTHOR declare" assertions and must read the
// same string, never a second copy that a rename here would leave behind.
export const PRESET_CUSTOMIZED_VAR = "preset.customized";
const CUSTOMIZED_BANNER_GATE = `{{ and ${disclosureTerm(EDIT_MODE_REF)} .${PRESET_CUSTOMIZED_VAR} }}`;

// [LAW:one-source-of-truth] Every synthesized segment is structural — removing
// one via `-` would strand its sibling artifacts (a toggle segment with no
// body, a menu with no host), and offering one back via `+` would insert a
// bare ref with none of the synthesis that made it work; the settings menu is
// also the door edit mode is REACHED from, so a `-` beside it would be a
// self-lockout. Ordinary content segments only.
const isChromeExempt = isReservedName;

// [LAW:one-source-of-truth] Every synthesized decl this pass produces, keyed
// by its final name — one accumulator threaded through every preset's splice
// so cross-preset names (disambiguated by `presetIdent`) can never collide.
interface ChromeArtifacts {
  readonly variables: Record<string, VariableDecl>;
  readonly actions: Record<string, ActionDeclType>;
  readonly segments: Record<string, SegmentDecl>;
}

// [LAW:one-source-of-truth] The domain name every `+` picker ranges, consumed
// two ways: here (by name, for every insertSegmentFrom action the splice
// synthesizes) and by registerDslConfig/deriveConfigActionValidators (which
// call `addableSegmentDomains` directly to populate `perConfigDomains` before
// resolving `from`). Both read this one string, so a synthesized action's
// domain name always resolves.
export const ADDABLE_DOMAIN = `${EDIT_NS}addable`;

// [LAW:one-source-of-truth] THE "what can `+` offer" set: every declared,
// non-exempt segment name. A segment already on the bar is offered too — a
// placement is an instance (brandon-segment-settings-i4n), so a second one is
// a second instance with its own id and its own settings, minted when the
// click lands (`mintPlacement`, layout-ops.ts). Exported so render.ts's
// registerDslConfig and config-validators.ts's deriveConfigActionValidators —
// the two sites that resolve `from` domains — merge this into
// `perConfigDomainsFor`'s map without each re-deriving it
// [LAW:locality-or-seam].
export function addableSegmentDomains(
  config: DslConfig,
): ReadonlyMap<string, ResolvedDomain> {
  // Segment names carry no colour, so this domain declares no `paletteOf` —
  // a `+` picker's options keep their band placement.
  return new Map([
    [
      ADDABLE_DOMAIN,
      {
        members: Object.keys(config.segments).filter((n) => !isChromeExempt(n)),
      },
    ],
  ]);
}

// One edit-mode chrome cell: a segment visible exactly while edit mode is on.
function chromeCell(
  name: string,
  template: string,
  artifacts: ChromeArtifacts,
): SegmentNode {
  artifacts.segments[name] = { template, when: EDIT_MODE_GATE };
  return { kind: "segment", name };
}

// The `-` affordance (drawn `🚫`) for one placement, addressed by its id: a literal
// `removeSegment` action, and the `{{ action }}` that clicks it, carried as the
// segment node's own `trail` so it is drawn inside that segment's cell. The
// action is named by its POSITION, as an insertion's is: an id is free text,
// and `ident` would collapse `git-2` and `git_2` onto one action.
function removeTerm(
  presetIdent: string,
  rootKey: string,
  posIdent: string,
  id: string,
  artifacts: ChromeArtifacts,
): string {
  const actionName = `${EDIT_NS}${presetIdent}.remove.${posIdent}`;
  artifacts.actions[actionName] = {
    persist: rootKey,
    removeSegment: id,
  };
  // A trail is not a segment, so no segment `when` hides it: it carries edit
  // mode's gate itself.
  return `{{ if ${disclosureTerm(EDIT_MODE_REF)} }}{{ action "${actionName}" "${REMOVE_GLYPH}" }}{{ end }}`;
}

// `ident` (every per-preset chrome name's `edit.<preset>.` prefix) emits no
// `:`, so no preset's chrome can land under this namespace.
const LABEL_NS = `${EDIT_NS}label:`;

// [LAW:one-source-of-truth] The segment a placed segment stands for in the
// layout's ARRANGEMENT (what `{{ layoutPreview }}` draws): a name label stands
// for the segment it names, since in edit mode it holds that segment's cell;
// every other edit-mode cell is an affordance over the arrangement, not part
// of it; anything else is itself.
export function arrangedSegment(name: string): string | undefined {
  if (name.startsWith(LABEL_NS)) return name.slice(LABEL_NS.length);
  return name.startsWith(EDIT_NS) ? undefined : name;
}

// The name a content segment wears in edit mode. Keyed by segment name alone —
// the label says the same thing in every preset — so N presets placing one
// segment mint one declaration.
function labelChrome(id: string, artifacts: ChromeArtifacts): SegmentNode {
  const name = `${LABEL_NS}${id}`;
  artifacts.segments[name] = {
    template: `{{ "${escapeTemplateLiteral(id)}" }}`,
    when: LABEL_GATE,
  };
  return { kind: "segment", name };
}

// The `+` affordance for one gap: an `insertSegmentFrom` action over this
// preset's addable domain, and the `{{ menu }}` over it for the cell `host` to
// carry (the menu's state key derives from its host segment's name). The menu's own disclosure (open state, page cursor, toggle action) is
// synthesized here by calling the SAME pure functions menu-synth.ts's
// file-parse-time pass calls — this pass runs too late to piggyback on that
// pass directly (it needs post-merge data menu-synth.ts's
// per-file timing does not have), so parity is achieved by sharing the
// functions, not by re-deriving the shape.
function insertTerm(
  presetIdent: string,
  rootKey: string,
  posIdent: string,
  domainName: OptionDomain,
  anchor: string,
  relation: "before" | "after",
  artifacts: ChromeArtifacts,
): { readonly host: string; readonly template: string } {
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

  // The `+` IS the trigger — no appended arrow (candybar-settings-ui-aok.4).
  // Beside a `-` that means something else entirely, a ▸ read as part of the
  // affordance rather than as a disclosure hint, so the trigger names the ACTION
  // its click performs instead: `+` inserts here, `✕` closes what `+` opened —
  // the same glyph, and the same effect, as the body's own close cell.
  //
  // [LAW:no-silent-failure] It is deliberately NOT one static display. A preset
  // has N insertion points whose rendered rows are byte-identical, and their
  // dropped bodies are identical too. The open one does wear its band's state
  // colour (node-registry picks `styles.trigger` whenever a segment has drops,
  // authored bg or not), but colour alone is a hint the glyph should not
  // depend on: with one static display, "which one did I open" would rest on
  // a tint the terminal's colour depth may flatten. The `✕` names it.
  //
  // Closed, the `✚` is green TEXT on the chrome cell's own ground — no
  // background of its own — so "add" reads by colour beside the red 🚫,
  // floored to stay legible on the tint that ground is. Open, the `✕` keeps
  // the trigger's own chosen text: the trigger's ground is decided after the
  // body evaluates (by the drop this very menu makes), so `bgOf` cannot see
  // it and a floor measured against it would measure the wrong colour.
  const open = disclosureTerm({ variable: stateKey, key: stateKey, member });
  const add = `readableOn (color "success") (bgOf) ${TEXT_MIN_CONTRAST}`;
  return {
    host: chromeSegName,
    template:
      `{{ $m := menu "${applyName}" "${ADD_GLYPH}" "${DISCLOSURE_GLYPH_CLOSE}" }}` +
      `{{ if ${open} }}{{ $m }}{{ else }}{{ fg (${add}) $m }}{{ end }}`,
  };
}

// [LAW:dataflow-not-control-flow] One recursive splice: every non-exempt
// segment child carries its `-` as its own trail and is followed by one gap
// cell holding the `+` that inserts after it, and the first also leads with a
// `+` (so N consecutive segments read `+ [seg1-] + [seg2-] + [seg3-] +` — N+1
// insert points, N remove points, N+1 chrome cells); a container child recurses; an exempt segment
// (a group toggle, a menu host, edit mode's own chrome) passes through
// untouched — but the disclosure BODY a segment hangs (a group's children,
// the settings rows) recurses like any container, so the cells inside an
// open group keep their `+`/`-` while the toggle that opens it has none.
// `posCounter` is threaded by reference so position identifiers stay unique
// across the WHOLE preset tree, not just one container.
function spliceContainer(
  node: ContainerNode,
  presetIdent: string,
  rootKey: string,
  domainName: OptionDomain,
  artifacts: ChromeArtifacts,
  posCounter: { n: number },
): ContainerNode {
  const children: LayoutNode[] = [];
  // [LAW:one-source-of-truth] The leading `+`'s position is "before the
  // first CONTENT segment", not "before the first child": a row led by exempt
  // chrome — the settings door, where it defaults — would otherwise anchor on
  // a segment no layout op may move. The trailing insert point needs no such
  // rule: every content segment's gap cell carries its own `after`.
  const firstContent = node.children.findIndex(
    (child) => child.kind === "segment" && !isChromeExempt(child.name),
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
    const id = placementId(child);
    const insert = (relation: "before" | "after", posIdent: string) =>
      insertTerm(
        presetIdent,
        rootKey,
        posIdent,
        domainName,
        id,
        relation,
        artifacts,
      );
    const leading =
      i === firstContent ? [insert("before", String(posCounter.n++))] : [];
    const afterPos = String(posCounter.n++);
    const after = insert("after", afterPos);
    // The remove button is drawn inside the cell of the segment it removes,
    // in whichever of the two views shows it, so nothing sits between them.
    // Every content segment has exactly one `after` insertion, so its
    // position names the removal too.
    const remove = removeTerm(presetIdent, rootKey, afterPos, id, artifacts);
    const cells: LayoutNode[] = [
      ...leading.map((lead) => chromeCell(lead.host, lead.template, artifacts)),
      // Labelled by the placement's id: two placements of one segment are
      // told apart by it, and a bare placement's id is its segment's name.
      { ...labelChrome(id, artifacts), trail: remove },
      {
        ...spliced,
        when: inNamesView("false", child.when ?? "true"),
        trail: remove,
      },
      chromeCell(after.host, after.template, artifacts),
    ];
    // [LAW:one-type-per-behavior] A content segment and its affordances are
    // ONE unit of the row: a horizontal container holding them, so the row
    // places its content cells and nothing else. Each child's position in its
    // parent is what its colour derives from (src/themes/decor.ts); chrome
    // spliced in as SIBLINGS took two of every three positions, so visible
    // neighbours were never consecutive and the row's tones collided
    // (brandon-theme-picker-bgw.8fp). Under a VERTICAL container the content
    // was a whole row (presetRoot stacks every root's rows vertically, so a
    // bare `"sidebar"` root and a `rows: { sys: "demo" }` row both arrive this
    // way): the unit becomes that row's one CELL, so the content keeps the
    // tone a one-cell row wears outside edit mode. The row carries no gate of
    // its own: the content's `when` stays on the content, so a hidden row still
    // shows its label and chrome in edit mode.
    const unit: LayoutNode = {
      kind: "container",
      direction: "horizontal",
      children: cells,
    };
    children.push(
      node.direction === "vertical"
        ? { kind: "container", direction: "horizontal", children: [unit] }
        : unit,
    );
  }
  return {
    ...node,
    children,
    ...(node.when !== undefined && { when: inNamesView("true", node.when) }),
  };
}

// brandon-layout-edit-2gc.5's other per-preset affordance: a `+`/`-` sibling
// that isn't about ONE gap but about the preset's authored root as a whole —
// synthesized the SAME way (one reset action targeting this preset's exact
// `persist` key, one segment hosting `{{ action }}`), UNCONDITIONALLY, with
// visibility carried entirely by CUSTOMIZED_BANNER_GATE
// [LAW:dataflow-not-control-flow]. It gets its own ROW (not a slot in the
// row-interleaved chrome spliceContainer builds) because it is not bound to any
// one segment gap — it is a fact about the whole tree — visible or not by a
// `when` that is every other synthesized affordance's edit-mode gate narrowed
// by the one extra fact this affordance depends on.
//
// candybar-settings-ui-aok.6 hangs edit mode's `(?)` off the same content. Its
// body hangs on the trigger (`SegmentNode.opens`) and drops below whichever row
// the trigger rides, so this function places ONE cell; see withTrailingCell.
function wrapWithPresetRows(
  splicedRoot: LayoutNode,
  presetName: string,
  presetIdent: string,
  rootKey: string,
  artifacts: ChromeArtifacts,
  lead: LayoutNode,
  tail: LayoutNode,
): LayoutNode {
  const actionName = `${EDIT_NS}${presetIdent}.resetLayout`;
  const chromeSegName = `${EDIT_NS}${presetIdent}.customized`;
  // [LAW:no-silent-failure] `reset` deletes the root the file authors at
  // `rootKey`'s path (candybar-config-dqe), restoring the bundled preset's
  // own tree — or, for a preset that stages the config root, the bundled
  // root — on the next reload. `rootKey` is gated the SAME way every other
  // `presets.<name>.root` target is (deriveConfigActionValidators), and is
  // ALWAYS a registered key — config-validators.ts's presetRootContributions
  // registers it
  // for every declared preset UNCONDITIONALLY, specifically so a preset
  // edited down to zero non-exempt segments (no removeTerm/insertTerm
  // persist actions left to register it) doesn't orphan this exact click.
  artifacts.actions[actionName] = { reset: rootKey };
  const label = escapeTemplateLiteral(presetName);
  artifacts.segments[chromeSegName] = {
    template: `{{ action "${actionName}" "↺ ${label} customized" }}`,
    when: CUSTOMIZED_BANNER_GATE,
  };
  return {
    kind: "container",
    direction: "vertical",
    children: [
      // The way out leads the top row, top left, where it is found without
      // reopening the menu edit mode was entered from.
      {
        kind: "container",
        direction: "horizontal",
        children: [lead, { kind: "segment", name: chromeSegName }],
      },
      // The `(?)`'s body drops BELOW the row the trigger rides while the
      // disclosure is open, like every other disclosure body in this codebase.
      withTrailingCell(splicedRoot, tail),
    ],
  };
}

// [LAW:one-source-of-truth] The `(?)` is a CELL, and its contract is that the
// caller joins it to a row it ALREADY HAS. Edit mode's rows are the ones
// spliceContainer just built, so the trigger joins the last of them. Two constraints pin that
// placement and nothing else satisfies both:
//
//  - Closed help must cost no LINE. A trigger given its own vertical slot is a
//    permanent row for the whole time edit mode is on, since a trigger's `when`
//    is its host surface's, never its own open state (a trigger you must open in
//    order to see could never be opened).
//  - Closed help must not MOVE the content. A cell trailing the last row sits
//    after every existing leaf, so no authored node's address — the position
//    its colour derives from — changes; the reset-banner row sits above the
//    content and is ruled out on that ground.
//
// A THIRD requirement decides how far the descent may go, and it outranks the
// other two: the trigger must be visible exactly when EDIT MODE is, since a
// trigger you must already have opened something else to reach is not a trigger.
// A container's `when` reaches every descendant, so descending into a
// `when`-bearing container would silently make its gate the trigger's gate.
// Pairing beside a gated SEGMENT is a different act and stays allowed:
// `{h: [gatedSeg, cell]}` puts the cell beside the gate rather than under it.
// A disclosure BODY is never descended into either, by shape: it hangs on its
// trigger segment (`SegmentNode.opens`) rather than sitting in the children
// list, so a preset root ending in a `kind: "group"` — ordinary authoring the
// A-grammar endorses — pairs the `(?)` beside the group's toggle, never inside
// a body most groups default closed.
//
// For a root whose last row is gated the three requirements are jointly
// unsatisfiable, so the priority is stated rather than left to whichever branch
// the recursion happens to reach: visible (always) > no move (always, since
// appending is still after every existing leaf) > no extra line (surrendered
// here, in exactly the configs where riding a row was never possible).
//
// [LAW:dataflow-not-control-flow] Total over the node shapes with no guard: a
// segment is a row of one that cannot hold a second cell, so it pairs into one;
// a vertical container's rows are its children, so it descends into the last one
// it may; anything else appends. An empty container has no last child and
// appends, which is the same answer.
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

// One preset's chrome-spliced root. presetRoot always yields a container —
// the merged rows stacked vertically — so a bare-segment fragment (the
// A-grammar's `{ seg, when }` shorthand is a legal root) arrives already
// wrapped as its one row, its own `when` lifted to the root, and a lone
// segment gets a `+` on each side like any other.
function spliceEditChromeForPreset(
  config: DslConfig,
  presetName: string,
  artifacts: ChromeArtifacts,
  lead: LayoutNode,
  tail: LayoutNode,
): LayoutNode {
  const { node } = presetRoot(config, presetName);
  const rootKey = presetRootKey(presetName);
  const domainName = ADDABLE_DOMAIN;
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
    lead,
    tail,
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
// `checkMenuDecls` already reserve unconditionally at parse time.
//
// Unconditional: the settings menu, synthesized into every config just before
// this pass, ensures `edit.toggle` and puts `✎ edit` in its body, so every bar
// can reach edit mode (brandon-settings-menu-d6f).
export function synthesizeEditChrome(config: DslConfig): DslConfig {
  const artifacts: ChromeArtifacts = {
    variables: {},
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
  // The view toggle rides the same trailing cell as the `(?)`, minted once for
  // the same reason: one key, so switching presets keeps the view you chose.
  artifacts.variables[EDIT_LIVE_KEY] = disclosureStateVar(
    EDIT_LIVE_KEY,
    DISCLOSURE_CLOSED,
  );
  artifacts.actions[EDIT_LIVE_KEY] = disclosureCycleAction(
    EDIT_LIVE_KEY,
    EDIT_LIVE_REF.member,
  );
  artifacts.segments[EDIT_LIVE_KEY] = {
    template: disclosureTrigger(EDIT_LIVE_KEY, ...EDIT_LIVE_DISPLAY),
    when: EDIT_MODE_GATE,
  };
  const tail: LayoutNode = {
    kind: "container",
    direction: "horizontal",
    children: [{ kind: "segment", name: EDIT_LIVE_KEY }, help],
  };
  // Leaving edit mode, minted once like the `(?)`: the same toggle the menu's
  // `✎ edit` fires, so the two cannot disagree about what "edit mode" is.
  artifacts.segments[EDIT_DONE_SEG] = {
    template: `{{ action "${EDIT_TOGGLE_ACTION}" "✎ done" }}`,
    when: EDIT_MODE_GATE,
  };
  const lead: LayoutNode = { kind: "segment", name: EDIT_DONE_SEG };
  const presets: Record<string, PresetDecl> = { ...config.presets };
  const roots: LayoutNode[] = [];
  for (const name of presetNames(config.presets)) {
    const root = spliceEditChromeForPreset(config, name, artifacts, lead, tail);
    roots.push(root);
    presets[name] = { ...presetByName(config.presets, name), root };
  }
  // [LAW:no-silent-failure] What the chrome reads and the config does not
  // declare (the banner's `.preset.customized`, the session.id every click
  // carries), merged UNDER the config so a user's own declaration wins.
  const ensured = synthesisInputs(artifacts, roots, config);
  return {
    ...config,
    variables: {
      ...ensured,
      ...config.variables,
      ...artifacts.variables,
    },
    actions: { ...config.actions, ...artifacts.actions },
    segments: { ...config.segments, ...artifacts.segments },
    presets,
  };
}
