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
  disclosureGate,
  disclosureStateVar,
  disclosureTrigger,
  type DisclosureRef,
} from "./disclosure.js";
import { declareHelp, type HelpDisclosure } from "./help.js";
import { PERSIST_HELP } from "../help-text.js";
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
import type { OptionDomain } from "./option-domain.js";
import {
  BOOLEAN_FALSE,
  BOOLEAN_MEMBERS,
  BOOLEAN_TRUE,
  PADDING_RANGE,
} from "../themes/policy.js";

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

// The body's content segments. `.1` scoped the body to what its acceptance
// names — switch presets, enter edit mode; `.3` adds the persist? selector
// beside them and the config menu below them.
const EDIT_SEG = `${SETTINGS_NS}edit`;

// ─── The config menu (candybar-settings-ui-aok.3) ───────────────────────────
//
// [LAW:one-source-of-truth] ONE control per setting. The drawer used to spell
// each of theme/style/look/preset TWICE — `{{ menu "applyTheme" }}` for the
// session beside `📌{{ menu "applyThemeForever" }}` for the durable default —
// two controls a reader had to reconcile at every glance, and two declarations
// an author had to keep in agreement. Here each setting is one control bound
// to one DUAL action, and the `persist?` selector beside them chooses which
// store every one of those controls writes [LAW:dataflow-not-control-flow].
//
// [LAW:no-mode-explosion] persist? is not a mode: it is a value in
// SessionState that the compiled action reads at click time. Nothing branches
// on it — not the synthesis (which mints the same tree either way), not the
// render walk, and not the daemon's writers, which are the same two writers
// they were before this menu existed.
//
// The selector sits in the menu's FIRST row, above and beside every control it
// governs, so it never stands over a row it cannot affect: every setting under
// it — preset here, theme/look/style/wrap/padding in the config row — is dual.
// `charset` and `colorCompatibility` are deliberately absent: they describe the
// TERMINAL (glyph coverage, colour depth), not a taste that varies between
// sessions, so they have no session half to choose and stay config-file
// settings (see CHARSETS in themes/policy.ts).
const PERSIST_SEG = `${SETTINGS_NS}persist`;
const CONFIG_SEG = `${SETTINGS_NS}config`;

// The selector's own state key, session-scoped and unchecked by default: you
// arrive in experimentation mode, and committing a value to every future
// session is a deliberate act. It also means a checkbox left armed yesterday
// cannot silently write a durable default today — SessionState is per session.
const PERSIST_KEY = PERSIST_SEG;

// [LAW:one-source-of-truth] The two disclosures this menu IS, as refs rather
// than as gate strings: every gate below — and every `(?)` nested inside them —
// derives from these, so the toggle that writes a key and the `when` that reads
// it cannot name different variables.
const SETTINGS_REF: DisclosureRef = {
  variable: SETTINGS_ANCHOR,
  member: SETTINGS_OPEN,
};
const CONFIG_REF: DisclosureRef = {
  variable: CONFIG_SEG,
  member: SETTINGS_OPEN,
};

// Gated on BOTH keys — a config row left open yesterday must not render beside
// a closed menu today. Nesting is conjunction, which is why it is one list.
const CONFIG_OPEN_GATE = disclosureGate(SETTINGS_REF, CONFIG_REF);

// The `(?)` that explains `persist?` — the one control in this menu whose
// behaviour a user cannot infer from its label, which is exactly why the ticket
// named it as a required use site. Its body says what the NEXT click does, in
// the same two sentences `--help` prints.
const PERSIST_HELP_SEG = `${SETTINGS_NS}help.persist`;

// [LAW:one-source-of-truth] The panel's surface colours, spelled once. The help
// cells must wear the same ones as the controls they explain — a `(?)` body in
// a different colour reads as a different panel — and that agreement is only
// guaranteed if there is one value to hand both.
const SETTINGS_SURFACE = { bg: "surface", fg: "foreground" } as const;

// [LAW:one-source-of-truth] One accordion key for every picker in the menu:
// one key holds one open member, so opening a theme picker closes the look
// picker. The settings menu is a narrow panel — two open drop-downs would
// overflow it — and this is the same shared-key mechanism group sugar uses,
// selected by a value, not a mode.
const PICKER_KEY = `${SETTINGS_NS}pickers`;

// [LAW:types-are-the-program] One row of the config menu, as data: everything
// that differs between "theme" and "padding" is a field here, so the six
// controls below are six VALUES and the synthesis that mints them is written
// once. A control names the two keys its dual action writes (they differ where
// history made them differ — SessionState "theme" over globals field
// "palette"), the variable whose value it displays, and its value source.
interface SettingControl {
  readonly name: string;
  readonly sessionKey: string;
  readonly configKey: string;
  // The `.effective` projection the daemon resolved for this render — the
  // value the bar is ACTUALLY rendering with, whatever produced it. A control
  // labels itself with this rather than with its own session key, so the label
  // can never name a value the bar is not in.
  readonly effectiveVar: string;
  readonly glyph: string;
  readonly domain: OptionDomain;
}

// [LAW:one-type-per-behavior] Four settings, one control shape: a glyph, the
// current value, a picker over a domain, and the ↺ that forgets the durable
// default. They differ only in which keys they write and which domain they
// range — configuration, so they are four VALUES of one synthesis, not four
// hand-written segments. `theme`'s two keys differ (SessionState "theme" over
// globals field "palette") for the historical reason recorded in
// state-validators.ts's baseline table; carrying BOTH keys as data is what
// makes that difference expressible without a special case.
//
// They are split into two lists by WHERE they render, because that is a fact
// about each control, not something the layout should recover by comparing
// names [LAW:dataflow-not-control-flow]. Switching arrangement is what people
// open this menu for, so the preset picker sits one click from the toggle;
// the display settings sit one disclosure deeper, which is what keeps the
// menu narrow when opened.
const PRIMARY_CONTROLS: readonly SettingControl[] = [
  {
    name: "preset",
    sessionKey: "preset",
    configKey: "preset",
    effectiveVar: "preset.effective",
    glyph: "▦",
    domain: "presets",
  },
];

const CONFIG_CONTROLS: readonly SettingControl[] = [
  {
    name: "theme",
    sessionKey: "theme",
    configKey: "palette",
    effectiveVar: "theme.effective",
    glyph: "🎨",
    domain: "themes",
  },
  {
    name: "look",
    sessionKey: "look",
    configKey: "look",
    effectiveVar: "look.effective",
    glyph: "◐",
    domain: "looks",
  },
  {
    name: "style",
    sessionKey: "style",
    configKey: "style",
    effectiveVar: "style.effective",
    glyph: "✦",
    domain: "styles",
  },
];

// The two settings whose affordance is not a picker: wrapping is a toggle (two
// members, so a menu would be a drop-down over a binary) and padding is a
// stepper over a range (16 picker cells for a value you nudge). Both are dual
// exactly like the pickers — only the affordance differs, so they carry the
// same key record and only their `domain` is absent.
//
// [LAW:one-source-of-truth] Declared as records rather than typed inline at
// each use, so every key in SETTINGS_WRITTEN_KEYS below traces to one
// declaration. When these two were string literals repeated across the set,
// the segment and the action, a rename in one place would have silently
// misclassified the key rather than failing.
interface KeyedSetting {
  readonly name: string;
  readonly sessionKey: string;
  readonly configKey: string;
}

const WRAP: KeyedSetting = {
  name: "wrap",
  sessionKey: "autoWrap",
  configKey: "autoWrap",
};
const PADDING: KeyedSetting = {
  name: "padding",
  sessionKey: "padding",
  configKey: "padding",
};

const WRAP_SEG = `${SETTINGS_NS}${WRAP.name}`;
const PADDING_SEG = `${SETTINGS_NS}${PADDING.name}`;

// Every picker control, wherever it renders — minting one is the same job in
// both rows, so the synthesis folds over this and the placement lists above
// decide only where each lands.
const PICKER_CONTROLS: readonly SettingControl[] = [
  ...PRIMARY_CONTROLS,
  ...CONFIG_CONTROLS,
];

// [LAW:one-source-of-truth] Every PLAIN key the settings menu writes — both
// destinations of every control it mints. Unlike the `settings.` names, these
// are ordinary words a config can own (`theme`, `padding`, …), so a reader
// cannot tell from the key alone whether the menu or the author wrote it. This
// set is the menu's own answer to "which keys do I write", derived from the
// same records the controls are minted from, so a consumer pairing it with an
// authorship check (test/helpers/ambient-chrome.ts) can never drift from what
// the synthesis actually declares.
export const SETTINGS_WRITTEN_KEYS: ReadonlySet<string> = new Set(
  [...PICKER_CONTROLS, WRAP, PADDING].flatMap((c) => [
    c.sessionKey,
    c.configKey,
  ]),
);

// [LAW:one-source-of-truth] A control's three names, derived from its one
// name — the segment that shows it, the action its picker applies, and the
// action its ↺ resets. Derived rather than declared so a control record can
// never name a segment whose picker writes a different setting.
const controlSeg = (name: string): string => `${SETTINGS_NS}${name}`;
const controlApply = (name: string): string => `${SETTINGS_NS}apply.${name}`;
const controlReset = (name: string): string => `${SETTINGS_NS}reset.${name}`;

// [LAW:one-source-of-truth] The predicate the body container gates on, derived
// from the same anchor string the toggle's cycle writes — spelled once here,
// exactly as lowerGroup derives a group body's `when` from the group's own
// reference name.
const SETTINGS_OPEN_GATE = disclosureGate(SETTINGS_REF);

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
function expandAnchor(
  node: AnchoredRoot | LayoutNode,
  help: HelpDisclosure,
): LayoutNode {
  if (node.kind === "segment") {
    return isSettingsAnchor(node.name)
      ? {
          kind: "container",
          direction: "vertical",
          children: [
            node,
            // Row one: what the menu is FOR — the persist? selector that says
            // where every setting below it lands, the preset switcher, the
            // door into the config menu, and the door into edit mode.
            {
              kind: "container",
              direction: "horizontal",
              children: [
                { kind: "segment", name: PERSIST_SEG },
                // The `(?)` rides the row that already exists, immediately
                // after the control it explains — so closed help costs no row
                // and widens the bar by one cell, and open help reads as an
                // answer to the checkbox on its left.
                //
                // Mid-row, DELIBERATELY, unlike edit mode's `(?)`, which
                // edit-chrome.ts goes to lengths to trail. The difference is
                // structural, not a discipline applied in one file and skipped
                // here. `nextHueShift` (src/dsl/render.ts:697) counts segment
                // leaves in pre-order, so a leaf's hue index is the number of
                // leaves before it — which makes the consequence arithmetic:
                // reordering leaves WITHIN a subtree cannot change the index of
                // any leaf AFTER it, since the subtree's leaf count does not
                // move. Edit chrome WRAPS the whole tree, so trailing there is
                // after every existing leaf and costs zero. This menu splices
                // MID-TREE at an anchor `withAnchor` lets the author put
                // anywhere, so no position inside it is after the rest of the
                // bar: the four leaves it adds (this trigger plus three body
                // lines) shift everything past the anchor by 4 x hue.step
                // wherever they sit. Trailing here would buy nothing and cost
                // the adjacency that IS the affordance. The fix is decoupling
                // colour from tree position — candybar-render-y5h, which fixes
                // every mid-tree synthesis at once rather than one file at a
                // time.
                help.trigger,
                ...PRIMARY_CONTROLS.map(
                  (c): LayoutNode => ({
                    kind: "segment",
                    name: controlSeg(c.name),
                  }),
                ),
                { kind: "segment", name: CONFIG_SEG },
                { kind: "segment", name: EDIT_SEG },
              ],
              when: SETTINGS_OPEN_GATE,
            },
            // The help body: one row, present only while the `(?)` is open,
            // directly under the row that asked the question.
            help.body,
            // Row two: the display settings, behind their own disclosure so
            // the menu opens narrow. Gated on BOTH keys — a config row left
            // open yesterday must not render beside a closed menu today; one
            // gate per disclosure, and this row is inside two of them.
            {
              kind: "container",
              direction: "horizontal",
              children: [
                ...CONFIG_CONTROLS.map(
                  (c): LayoutNode => ({
                    kind: "segment",
                    name: controlSeg(c.name),
                  }),
                ),
                { kind: "segment", name: WRAP_SEG },
                { kind: "segment", name: PADDING_SEG },
              ],
              when: CONFIG_OPEN_GATE,
            },
          ],
        }
      : node;
  }
  return {
    ...node,
    children: node.children.map((child) => expandAnchor(child, help)),
  };
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
  // The accordion key the menu shares with its siblings, or undefined for a
  // menu that toggles only itself — the same `key` option `{{ menu }}` takes,
  // threaded here so the synthesized artifacts and the rendered disclosure
  // derive one identity from one value [LAW:one-source-of-truth].
  sharedKey?: string,
): void {
  const member = menuMember(applyName);
  const stateKey = menuStateKey(segName, applyName, sharedKey);
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
function settingsArtifacts(): {
  artifacts: MenuArtifacts;
  help: HelpDisclosure;
} {
  const artifacts: MenuArtifacts = {
    variables: {
      [SETTINGS_ANCHOR]: disclosureStateVar(SETTINGS_ANCHOR, DISCLOSURE_CLOSED),
    },
    actions: {
      [SETTINGS_ANCHOR]: disclosureCycleAction(SETTINGS_ANCHOR, SETTINGS_OPEN),
      [CONFIG_SEG]: disclosureCycleAction(CONFIG_SEG, SETTINGS_OPEN),
      // [LAW:one-source-of-truth] The selector is an ordinary session cycle
      // over the one boolean spelling SessionState uses — off first, because
      // an unwritten key counts as the first member and the menu opens in
      // experimentation mode.
      [PERSIST_SEG]: {
        set: PERSIST_KEY,
        cycle: [BOOLEAN_FALSE, BOOLEAN_TRUE],
      },
    },
    segments: {
      // [LAW:representation] The glyph trails the label it gates, per the
      // disclosure vocabulary every other toggle in the bar reads by.
      [SETTINGS_ANCHOR]: {
        template: disclosureTrigger(
          SETTINGS_ANCHOR,
          `☰ ${DISCLOSURE_GLYPH_CLOSED}`,
          `☰ ${DISCLOSURE_GLYPH_OPEN}`,
        ),
        ...SETTINGS_SURFACE,
      },
      // [LAW:representation] The checkbox states what the NEXT write does,
      // which is why the glyph and the word live together: "☑ persist?" is
      // the whole explanation of where the click below it lands.
      [PERSIST_SEG]: {
        template: `{{ action "${PERSIST_SEG}" "☐ persist?" "☑ persist?" }}`,
        ...SETTINGS_SURFACE,
      },
      [CONFIG_SEG]: {
        template: disclosureTrigger(
          CONFIG_SEG,
          `⚙ config ${DISCLOSURE_GLYPH_CLOSED}`,
          `⚙ config ${DISCLOSURE_GLYPH_OPEN}`,
        ),
        ...SETTINGS_SURFACE,
      },
      // [LAW:one-type-per-behavior] Both non-picker controls read the same
      // `.effective` projection their picker siblings read, and write the
      // same two stores through the same dual arm — a toggle and a stepper
      // are affordances over one behavior, not two kinds of setting.
      [WRAP_SEG]: {
        template:
          `{{ action "${controlApply("wrap")}" "wrap: on" "wrap: off" }} ` +
          `{{ action "${controlReset("wrap")}" "↺" }}`,
        ...SETTINGS_SURFACE,
      },
      [PADDING_SEG]: {
        template:
          `{{ action "${controlApply("padding")}.down" "◀" }} ` +
          "padding {{ .padding.effective }} " +
          `{{ action "${controlApply("padding")}.up" "▶" }} ` +
          `{{ action "${controlReset("padding")}" "↺" }}`,
        ...SETTINGS_SURFACE,
      },
      // The entry point edit mode never had: `edit.toggle` is a reserved action
      // whose only bundled reference lives in the `toolbar` segment, which a
      // user config's `root` drops like everything else. Here it is reachable
      // from a segment no config can drop.
      [EDIT_SEG]: {
        template: `{{ action "${EDIT_TOGGLE_ACTION}" "✎ edit" "✎ done" }}`,
        ...SETTINGS_SURFACE,
      },
    },
  };
  artifacts.variables[PERSIST_KEY] = {
    kind: "state",
    key: PERSIST_KEY,
    default: BOOLEAN_FALSE,
  };
  artifacts.variables[CONFIG_SEG] = disclosureStateVar(
    CONFIG_SEG,
    DISCLOSURE_CLOSED,
  );
  declareSettingControls(artifacts);
  // [LAW:one-source-of-truth] The `(?)` is minted here, with the panel it
  // belongs to, and its two NODES are returned so `expandAnchor` places them by
  // the value it is handed rather than by re-deriving names this pass already
  // owns. Nested in SETTINGS_REF, so closing the menu takes the open help with
  // it.
  const help = declareHelp(
    PERSIST_HELP_SEG,
    PERSIST_HELP,
    [SETTINGS_REF],
    artifacts,
    SETTINGS_SURFACE,
  );
  return { artifacts, help };
}

// [LAW:one-source-of-truth] Every setting the menu offers, minted from the one
// table that describes them. A picker control is a glyph, its live value, a
// `{{ menu }}` over its domain, and the ↺ that forgets its durable default;
// wrap and padding differ only in affordance. Every apply action here is DUAL
// — one declaration naming both destination keys and the selector that chooses
// between them — so the panel spells each setting exactly once and the click
// carries the destination as data [LAW:dataflow-not-control-flow].
//
// [LAW:single-enforcer] Nothing here declares a gate. `deriveActionValidators`
// and `deriveConfigActionValidators` each explode these dual declarations
// (actionDestinations) and derive the same specs they would have derived from
// the pair of single-destination actions this replaces — so the writable-key
// surface is byte-for-byte what it was when the drawer spelled both halves.
function declareSettingControls(artifacts: MenuArtifacts): void {
  for (const c of PICKER_CONTROLS) {
    const seg = controlSeg(c.name);
    const apply = controlApply(c.name);
    artifacts.segments[seg] = {
      template:
        `${c.glyph} {{ .${c.effectiveVar} }} ` +
        `{{ menu "${apply}" "${DISCLOSURE_GLYPH_CLOSED}" "${DISCLOSURE_GLYPH_OPEN}" ` +
        `(dict "key" "${PICKER_KEY}" "closeOnPick" true) }} ` +
        `{{ action "${controlReset(c.name)}" "↺" }}`,
      ...SETTINGS_SURFACE,
    };
    artifacts.actions[apply] = {
      set: c.sessionKey,
      persist: c.configKey,
      persistWhen: PERSIST_KEY,
      from: c.domain,
    };
    // [LAW:one-source-of-truth] ↺ clears the DURABLE default only — the one
    // write the user cannot otherwise take back, since a session value dies
    // with the session. Its target is the config key the dual's durable half
    // writes, read from the same record, so the two can never name different
    // settings.
    artifacts.actions[controlReset(c.name)] = { reset: c.configKey };
    declareHostedMenu(seg, apply, artifacts, PICKER_KEY);
  }
  artifacts.actions[controlApply(WRAP.name)] = {
    set: WRAP.sessionKey,
    persist: WRAP.configKey,
    persistWhen: PERSIST_KEY,
    cycle: [...BOOLEAN_MEMBERS],
  };
  artifacts.actions[controlReset(WRAP.name)] = { reset: WRAP.configKey };
  // [LAW:one-source-of-truth] The stepper's bounds are PADDING_RANGE, the same
  // range the loader validates a config-file `padding` against and the same one
  // both write gates enforce — a click can never reach a value the file could
  // not have held.
  for (const by of [-1, 1]) {
    artifacts.actions[
      `${controlApply(PADDING.name)}.${by < 0 ? "down" : "up"}`
    ] = {
      set: PADDING.sessionKey,
      persist: PADDING.configKey,
      persistWhen: PERSIST_KEY,
      ...PADDING_RANGE,
      by,
    };
  }
  artifacts.actions[controlReset(PADDING.name)] = { reset: PADDING.configKey };
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
  const { artifacts, help } = settingsArtifacts();
  ensureEditToggle(artifacts);
  const presets: Record<string, PresetDecl> = { ...config.presets };
  for (const name of presetNames(config.presets)) {
    const { node } = presetRoot(config, name);
    presets[name] = {
      ...presetByName(config.presets, name),
      root: expandAnchor(withAnchor(node), help),
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
