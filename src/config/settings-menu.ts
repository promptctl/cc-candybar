// [LAW:one-source-of-truth] candybar-settings-ui-aok.1 — THE global settings
// menu: one disclosure that every rendered bar carries, whatever the config
// says. It exists because `root` replaces wholesale: a user who writes `root:`
// (the ordinary reason to write a config at all) silently deletes every
// interactive surface the bundled default placed there — presets, edit mode,
// the value controls. A door the user can delete by accident is not a door.
//
// [LAW:dataflow-not-control-flow] Placement is a POSITION, never a mode. The
// synthesis runs the same two total functions on every preset root, in the same
// order, every load: `withAnchor` yields a tree that CONTAINS the anchor — the
// author's own placement untouched, or the default position appended — and
// `expandAnchor` replaces that one leaf with the lowered disclosure subtree.
// "The author placed it" and "the author did not" differ only in the VALUE
// handed to one splice; there is no second code path to keep in agreement.
//
// [LAW:one-type-per-behavior] Nothing here is a new render or interaction
// concept. The menu is the disclosure primitive's fourth instance, alongside
// group sugar, `{{ menu }}`, and edit mode's toggle: it calls the SAME
// `disclosureStateVar`/`disclosureCycleAction`/`menuStateKey` functions those
// three call, so a synthesized global menu and a hand-authored group are
// indistinguishable to the render walk.
//
// WHY THIS RUNS FROM validateConfig, BEFORE synthesizeEditChrome — the two
// passes both rewrite every preset root, so their order is a real decision:
//   • It cannot run at parse time (loader/*.ts) like group/menu synthesis,
//     because the tree it must splice into only exists after merge: the user's
//     `root` replaces the bundled default's, and it is the MERGED root the menu
//     has to be present in.
//   • It runs BEFORE edit chrome so edit chrome walks the final content tree.
//     Every name minted here lives under the reserved `settings.` namespace,
//     which `isChromeExempt` excludes, so the menu never acquires a `+`/`-`
//     affordance and can never be edited out of the bar it is the entry point
//     to. Running after would splice the menu into an already-chromed tree,
//     landing it between a segment and the `-` that removes it.
//   • It also GUARANTEES `edit.toggle` (see ensureEditToggle below), which is
//     precisely what edit chrome's own demand gate reads — so the ordering is
//     load-bearing in that direction too, not merely tidy.

import type { ActionDecl } from "./action.js";
import type {
  DslConfig,
  LayoutNode,
  PresetDecl,
  SegmentDecl,
  VariableDecl,
} from "./dsl-types.js";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSED,
  DISCLOSURE_GLYPH_OPEN,
  disclosureCycleAction,
  disclosureStateVar,
} from "./disclosure.js";
import {
  EDIT_MODE_KEY,
  EDIT_MODE_OPEN,
  EDIT_TOGGLE_ACTION,
} from "./loader/edit-mode.js";
import {
  menuActionName,
  menuMember,
  menuPageKey,
  menuStateKey,
} from "./menu-keys.js";
import { presetByName, presetNames, presetRoot } from "./presets.js";

// [LAW:one-source-of-truth] The reserved namespace every artifact this pass
// mints lives under, mirroring `groups.`/`menus.`/`edit.`. Reserved at parse
// time (reservedNamespaceCollisions, from dsl-loader's validateTopLevel) so a
// user name under it is a loud load error rather than a silent shadowing of
// the one surface they cannot afford to lose.
export const SETTINGS_NS = "settings.";

// [LAW:one-source-of-truth] THE anchor: one string that is simultaneously the
// segment name an author places in `root` to choose the menu's position, the
// name of the toggle segment the synthesis puts there, the disclosure's state
// variable, and its cycle action. Group sugar already spans those four with one
// `groups.<name>` string for the same reason — one name means the toggle's
// click and the body's `when` cannot address different keys.
export const SETTINGS_ANCHOR = `${SETTINGS_NS}menu`;

// The disclosure's open member. Same spelling edit mode uses for its own binary
// toggle — a binary disclosure holds the CLOSED sentinel or this.
const SETTINGS_OPEN = EDIT_MODE_OPEN;

// The body's two content segments and the preset picker's apply action. `.1`
// scopes the body to what its acceptance names — switch presets, enter edit
// mode. The remaining display controls arrive with the config menu (`.3`),
// which is the child that owns them.
const PRESETS_SEG = `${SETTINGS_NS}presets`;
const EDIT_SEG = `${SETTINGS_NS}edit`;
const APPLY_PRESET_ACTION = `${SETTINGS_NS}applyPreset`;

// [LAW:one-source-of-truth] The predicate the body container gates on, derived
// from the same anchor string the toggle's cycle writes — spelled once here,
// exactly as lowerGroup derives a group body's `when` from the group's own
// reference name.
const SETTINGS_OPEN_GATE = `{{ eq .${SETTINGS_ANCHOR} "${SETTINGS_OPEN}" }}`;

// [LAW:single-enforcer] The one answer to "is this segment reference the global
// menu's anchor". cross-ref.ts asks it to accept an authored placement of a name
// no config declares (this pass provides it, unconditionally, immediately after
// cross-ref passes), and to reject a SECOND placement — one key holds one open
// state, so two anchors would be two toggles writing one disclosure.
export function isSettingsAnchor(segmentName: string): boolean {
  return segmentName === SETTINGS_ANCHOR;
}

// ─── The anchored-root stamp ────────────────────────────────────────────────

declare const anchored: unique symbol;

// [LAW:parse-dont-validate] A tree that is KNOWN to contain the anchor. The
// stamp is the proof, so `expandAnchor` has no "anchor missing" arm to guard
// and no answer-shaped void to return: the only way to obtain this type is to
// go through `withAnchor`, which establishes the fact by construction.
//
// The theorem includes the anchor inheriting no gate the DEFAULT placement
// descended into — a weaker stamp ("contains an anchor" alone) is what let a
// `when`-gated first row silently swallow the menu. Two gates are exempt
// because they are explicit authorial statements rather than accidents: the
// author's own placement of the anchor (they chose that position, gate and
// all) and a `when` on the root itself (there is no bar at all under that
// condition, so there is nothing to host a menu on).
type AnchoredRoot = LayoutNode & { readonly [anchored]: true };

// [LAW:dataflow-not-control-flow] The default position, as structural recursion
// over the LayoutNode union rather than a placement mode: descend to the bar's
// FIRST horizontal row and append there — where the bundled default's own
// settings affordance already sits, and the place a one-row user config puts
// everything. Total over every tree shape, including the degenerate ones: a
// bare-segment root (the A-grammar collapses a lone top-level ref) grows a
// horizontal wrapper, and an empty container simply becomes the row.
function appendAnchor(node: LayoutNode): LayoutNode {
  const anchorRef: LayoutNode = { kind: "segment", name: SETTINGS_ANCHOR };
  if (node.kind === "segment") {
    // [LAW:no-silent-failure] A bare-segment root may carry its OWN `when` — an
    // author gating their whole bar behind a condition. This wrapper is a brand
    // new node, so without carrying that gate up, everything spliced beside the
    // segment (this menu, and the reset banner edit chrome later prepends by
    // reading `splicedRoot.when`) would render past a gate the author wrote.
    // The identical carry-up spliceEditChromeForPreset performs, one pass over.
    return {
      kind: "container",
      direction: "horizontal",
      children: [node, anchorRef],
      ...(node.when !== undefined && { when: node.when }),
    };
  }
  const [first, ...rest] = node.children;
  // [LAW:no-silent-failure] Descend only into an UNGATED child. A gate on an
  // inner row is a statement about that row's content, not about the bar — an
  // author writing an ordinary conditional first row (a git row shown only
  // inside a repo) has no idea the default placement attaches the menu there,
  // and inheriting that gate would silently delete the one surface this pass
  // exists to make undeletable, under exactly their condition. When the first
  // row is gated the anchor becomes its own ungated row on this container
  // instead, which is a position the author can still override by placing the
  // anchor themselves.
  //
  // The ROOT's own `when` is deliberately NOT lifted out of, here or in the
  // segment arm above: gating the whole tree is an explicit statement that
  // there is no bar under this condition, and there is no bar to host a menu
  // on. That is the same "the author's explicit choice is the answer" rule
  // that honors an author-placed anchor inside a gated row — and it is what
  // keeps edit chrome's reset banner gated with the content it describes.
  if (
    node.direction === "vertical" &&
    first !== undefined &&
    first.when === undefined
  ) {
    return { ...node, children: [appendAnchor(first), ...rest] };
  }
  return { ...node, children: [...node.children, anchorRef] };
}

// [LAW:parse-dont-validate] The checkpoint: in, a tree that may or may not name
// the anchor; out, a tree that provably does. The author's placement passes
// through byte-identical — the position they chose IS the answer — and its
// absence is answered with the default position. One value, two sources.
function withAnchor(node: LayoutNode): AnchoredRoot {
  const placed = countAnchors(node) > 0 ? node : appendAnchor(node);
  return placed as AnchoredRoot;
}

// [LAW:single-enforcer] THE anchor census, read by both consumers of the count:
// `withAnchor` (is there a placement to honor?) and the loader's duplicate check
// (is there more than one?). One traversal definition, so "placed" cannot mean
// different things to the two.
export function countAnchors(node: LayoutNode): number {
  if (node.kind === "segment") return isSettingsAnchor(node.name) ? 1 : 0;
  return node.children.reduce((n, child) => n + countAnchors(child), 0);
}

// [LAW:one-type-per-behavior] The lowering, identical in shape to lowerGroup's:
// a vertical pair of the toggle segment and a `when`-gated body. Replaces the
// anchor leaf wherever it sits, so the author's chosen position is the menu's
// position with nothing else moved.
function expandAnchor(node: AnchoredRoot | LayoutNode): LayoutNode {
  if (node.kind === "segment") {
    return isSettingsAnchor(node.name)
      ? {
          kind: "container",
          direction: "vertical",
          children: [
            node,
            {
              kind: "container",
              direction: "horizontal",
              children: [
                { kind: "segment", name: PRESETS_SEG },
                { kind: "segment", name: EDIT_SEG },
              ],
              when: SETTINGS_OPEN_GATE,
            },
          ],
        }
      : node;
  }
  return { ...node, children: node.children.map(expandAnchor) };
}

// ─── The artifacts ──────────────────────────────────────────────────────────

interface MenuArtifacts {
  readonly variables: Record<string, VariableDecl>;
  readonly actions: Record<string, ActionDecl>;
  readonly segments: Record<string, SegmentDecl>;
}

// [LAW:single-enforcer] The `{{ menu }}` disclosure a body segment hosts,
// synthesized by calling the SAME pure functions menu-synth.ts's parse-time pass
// calls — the identical move edit-chrome.ts's insertChrome makes, and for the
// identical reason: this pass runs too late to piggyback on that one, so parity
// comes from sharing the derivation, never from restating it.
function declareHostedMenu(
  segName: string,
  applyName: string,
  artifacts: MenuArtifacts,
): void {
  const member = menuMember(applyName);
  const stateKey = menuStateKey(segName, applyName, undefined);
  const pageKey = menuPageKey(stateKey);
  artifacts.variables[stateKey] = disclosureStateVar(
    stateKey,
    DISCLOSURE_CLOSED,
  );
  artifacts.variables[pageKey] = { kind: "state", key: pageKey, default: "0" };
  artifacts.actions[menuActionName(stateKey, member)] = disclosureCycleAction(
    stateKey,
    member,
  );
  artifacts.actions[pageKey] = { set: pageKey, int: true };
}

// [LAW:one-source-of-truth] Everything the menu is, minted ONCE per config and
// merely REFERENCED from each preset root. This is what makes the pass
// idempotent across N presets for free: a preset root carries a segment
// reference, and a second reference to one declaration is a reuse, not the
// self-collision a second `kind: "group"` node would be (see the settingsDrawer
// comment in default-dsl-config.ts for that hazard in its original form).
function settingsArtifacts(): MenuArtifacts {
  const artifacts: MenuArtifacts = {
    variables: {
      [SETTINGS_ANCHOR]: disclosureStateVar(SETTINGS_ANCHOR, DISCLOSURE_CLOSED),
    },
    actions: {
      [SETTINGS_ANCHOR]: disclosureCycleAction(SETTINGS_ANCHOR, SETTINGS_OPEN),
      // [LAW:single-enforcer] The picker's apply effect, gated by derivation
      // like every other `from`-sourced set: `presets` is a per-config domain
      // both deriveActionValidators and the rendered options resolve through
      // one `resolveOptionDomain`, so this adds a control, never a gate.
      [APPLY_PRESET_ACTION]: { set: "preset", from: "presets" },
    },
    segments: {
      // [LAW:representation] The glyph trails the label it gates, per the
      // disclosure vocabulary every other toggle in the bar reads by.
      [SETTINGS_ANCHOR]: {
        template: `{{ action "${SETTINGS_ANCHOR}" "☰ ${DISCLOSURE_GLYPH_CLOSED}" "☰ ${DISCLOSURE_GLYPH_OPEN}" }}`,
        bg: "surface",
        fg: "foreground",
      },
      [PRESETS_SEG]: {
        template: `▦ {{ menu "${APPLY_PRESET_ACTION}" (dict "closeOnPick" true) }}`,
        bg: "surface",
        fg: "foreground",
      },
      // The entry point edit mode never had: `edit.toggle` is a reserved action
      // whose only bundled reference lives in the `toolbar` segment, which a
      // user config's `root` drops like everything else. Here it is reachable
      // from a segment no config can drop.
      [EDIT_SEG]: {
        template: `{{ action "${EDIT_TOGGLE_ACTION}" "✎ edit" "✎ done" }}`,
        bg: "surface",
        fg: "foreground",
      },
    },
  };
  declareHostedMenu(PRESETS_SEG, APPLY_PRESET_ACTION, artifacts);
  return artifacts;
}

// [LAW:one-source-of-truth] Edit mode's toggle, ensured rather than duplicated:
// both this pass and synthesizeEditModeToggle produce it by calling the same two
// disclosure functions on the same two exported constants, so the two mints are
// the same value by construction and whichever lands first is the only one.
// Ensuring it here is not an optional courtesy — the EDIT_SEG segment above
// references `edit.toggle`, and that pass is demand-driven off a scan of the
// segments a FILE declared, which cannot see a segment this pass mints later.
function ensureEditToggle(artifacts: MenuArtifacts): void {
  artifacts.variables[EDIT_MODE_KEY] = disclosureStateVar(
    EDIT_MODE_KEY,
    DISCLOSURE_CLOSED,
  );
  artifacts.actions[EDIT_TOGGLE_ACTION] = disclosureCycleAction(
    EDIT_MODE_KEY,
    EDIT_MODE_OPEN,
  );
}

// [LAW:one-source-of-truth] The variable whose presence IS the precondition,
// named once so the predicate below and the load error cross-ref.ts raises when
// it fails cannot describe different variables.
export const SESSION_ID_VAR = "session.id";

// [LAW:types-are-the-program] The menu's one structural prerequisite, read as a
// value: a global `session.id`. It is not a demand gate and not a preference —
// the menu is a CLICK surface, every click composes a URL whose first segment is
// `session.id` read from the store, and cross-ref.ts already rejects an AUTHORED
// state read or `set` write in a config that declares no such variable. A config
// without it describes a static, non-interactive bar, and there is no menu to
// place on one. Every config the daemon renders merges the bundled default,
// which declares `session.id`, so in production this is universally true; what
// it excludes is the hand-built static config, not a user.
//
// [LAW:one-source-of-truth] Exported because this is THE fact "will the anchor
// resolve to a segment?" — asked here to decide whether to mint the menu, and
// asked by cross-ref.ts to decide whether an authored placement of the anchor is
// a reference this pass is about to satisfy or a dangling one. Two readers, one
// predicate: when they were two predicates, cross-ref accepted an anchor this
// pass then declined to provide, and the un-lowered reference reached the render
// walk to throw at `lookupSegment`.
export function canHostSessionState(config: DslConfig): boolean {
  return Object.prototype.hasOwnProperty.call(config.variables, SESSION_ID_VAR);
}

// [LAW:single-enforcer] THE synthesis entry point, called once from
// validateConfig after cross-ref/cycle checks pass and before edit chrome.
// Every declared preset — the floor `default` included — gets an explicit
// `presets[name].root` carrying its anchored, expanded tree; `config.root`
// itself is left untouched, exactly as synthesizeEditChrome leaves it, because
// presetRoot falls back to it only for a preset declaring no root of its own
// and every name now declares one.
export function synthesizeSettingsMenu(config: DslConfig): DslConfig {
  if (!canHostSessionState(config)) return config;
  const artifacts = settingsArtifacts();
  ensureEditToggle(artifacts);
  const presets: Record<string, PresetDecl> = { ...config.presets };
  for (const name of presetNames(config.presets)) {
    const { node } = presetRoot(config, name);
    presets[name] = {
      ...presetByName(config.presets, name),
      root: expandAnchor(withAnchor(node)),
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
