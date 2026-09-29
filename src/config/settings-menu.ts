// [LAW:one-source-of-truth] candybar-settings-ui-aok.1 — THE global settings
// menu: one disclosure that every rendered bar carries, whatever the config
// says — presets, edit mode, and the value controls are reachable from any
// root an author writes, not only from rows they inherited.
//
// [LAW:dataflow-not-control-flow] Placement is a POSITION, never a mode. The
// synthesis runs the same two total functions on every preset root, in the same
// order, every load: `withAnchor` yields a tree that CONTAINS the anchor — the
// author's own placement untouched, or the default position prepended — and
// `expandAnchor` replaces that one leaf with the lowered disclosure subtree.
// "The author placed it" and "the author did not" differ only in the VALUE
// handed to one splice; there is no second code path to keep in agreement.
//
// [LAW:one-type-per-behavior] Nothing here is a new render or interaction
// concept. The menu is the disclosure primitive's fourth instance, alongside
// group sugar, `{{ menu }}`, and edit mode's toggle: it calls the SAME
// `disclosureStateVar`/`disclosureCycleAction` functions those
// three call, so a synthesized global menu and a hand-authored group are
// indistinguishable to the render walk.
//
// WHY THIS RUNS FROM validateConfig, BEFORE synthesizeEditChrome — the two
// passes both rewrite every preset root, so their order is a real decision:
//   • It cannot run at parse time (loader/*.ts) like group/menu synthesis,
//     because the tree it must splice into only exists after merge: a file's
//     rows merge by name over the bundled default's, and it is the MERGED root
//     the menu has to be present in.
//   • It runs BEFORE edit chrome so edit chrome walks the final content tree.
//     Every name minted here lives under the reserved `candybar.` namespace,
//     which `isChromeExempt` excludes, so the menu never acquires a `+`/`-`
//     affordance and can never be edited out of the bar it is the entry point
//     to. Running after would splice the menu into an already-chromed tree,
//     landing it between a segment and the `-` that removes it.
//   • It also GUARANTEES `edit.toggle` and the `edit.mode` state it cycles
//     (see ensureEditToggle below), which edit chrome's gates read and its
//     `✎ done` fires — so the ordering is load-bearing in that direction too,
//     not merely tidy.

import type { ActionDecl } from "./action.js";
import {
  walkNodes,
  type DisclosureRef,
  type DslConfig,
  type LayoutNode,
  type PresetDecl,
  type SegmentDecl,
  type VariableDecl,
} from "./dsl-types.js";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSED,
  DISCLOSURE_GLYPH_OPEN,
  DOOR_CLOSE_GLYPH,
  DOOR_GLYPH,
  disclosureCycleAction,
  disclosureNode,
  disclosureStateVar,
  disclosureTrigger,
} from "./disclosure.js";
import { CHECKS } from "../doctor/checks.js";
import {
  doctorReportKeys,
  VERDICT_OK,
  VERDICT_UNRUN,
} from "../doctor/report.js";
import {
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
  EDIT_TOGGLE_ACTION,
} from "./loader/edit-mode.js";
import { menuActionName, menuMember, sharedMenuStateKey } from "./menu-keys.js";
import { presetByName, presetNames, presetRoot } from "./presets.js";
import { quickActions } from "./quick-actions.js";
import { commandTray } from "./command-tray.js";
import { confirmStep } from "./confirm-step.js";
import { SETTINGS_NS } from "./loader/reserved-namespace.js";
import type { OptionDomain } from "./option-domain.js";
import { SETTINGS, type SettingProjection } from "./setting-projections.js";
import { synthesisInputs } from "./synthesis-inputs.js";
import {
  BOOLEAN_MEMBERS,
  BOOLEAN_TRUE,
  PADDING_RANGE,
} from "../themes/policy.js";

// [LAW:one-source-of-truth] THE anchor: one string that is simultaneously the
// segment name an author places in `root` to choose the menu's position, the
// name of the toggle segment the synthesis puts there, the disclosure's state
// variable, and its cycle action. Group sugar already spans those four with one
// `groups.<name>` string for the same reason — one name means the toggle's
// click and the body's `when` cannot address different keys.
export const SETTINGS_ANCHOR = `${SETTINGS_NS}menu`;

// The open member of every binary disclosure this menu mints — each holds the
// CLOSED sentinel or this.
export const SETTINGS_OPEN = "open";

// The body's content segments. `.1` scoped the body to what its acceptance
// names — switch presets, enter edit mode; `.3` adds the config menu below
// them.
const EDIT_SEG = `${SETTINGS_NS}edit`;
const SETTINGS_CLOSE = `${SETTINGS_NS}close`;
const TOOLBAR_SEG = `${SETTINGS_NS}toolbar`;
const TOOLBAR = quickActions(SETTINGS_NS);
const COMMANDS_SEG = `${SETTINGS_NS}commands`;
const COMMANDS = commandTray(`${COMMANDS_SEG}.`);

// ─── The config menu (candybar-settings-ui-aok.3) ───────────────────────────
//
// [LAW:one-source-of-truth] ONE control per setting, and every control writes
// the session: a pick is a DRAFT until it is saved (brandon-save-undo-bwi.hpi).
// The drafts are derived, never flagged — src/daemon/setting-drafts.ts compares
// the session with what the config file resolves — and `💾 save N` exists
// exactly while there are N of them, writing all of them to the file in one
// click. There is no destination selector to consult: where a click lands is
// the same place every time, and saving is its own, visible act.
const CONFIG_SEG = `${SETTINGS_NS}config`;
const SAVE_SEG = `${SETTINGS_NS}save`;
const UNSAVED_VAR = `${SETTINGS_NS}unsaved`;

// ─── Presets the user makes (brandon-save-undo-bwi.o6u) ─────────────────────
const PRESET_SAVE = `${SETTINGS_NS}preset.save`;
const PRESET_DELETE = `${SETTINGS_NS}preset.delete`;

// ─── Reset all (brandon-save-undo-bwi.wt5) ──────────────────────────────────
//
// [LAW:composability] `⟲ reset all` is every control's ↺ fired as one click —
// a `do` over the resets the controls already declare, so it cannot reset a
// setting differently from that setting's own ↺, and one click is one step in
// the undo history. It takes two clicks: the first arms it (a session key), the
// second fires. Every click that can bring its row into view — the door and the
// `⚙ config` toggle, the only two ways in — disarms it, so the confirming click
// is always made in the view the arming click was made in, however that view
// was later closed.
const RESET_ALL_SEG = `${SETTINGS_NS}resetAll`;
// The door's and the config panel's own open/close cycles, each fired beside
// the disarm.
const DOOR_TOGGLE = `${SETTINGS_ANCHOR}.toggle`;
const CONFIG_TOGGLE = `${CONFIG_SEG}.toggle`;

// [LAW:one-source-of-truth] The two disclosures this menu IS, as refs rather
// than as gate strings: every gate below — and every `(?)` nested inside them —
// derives from these, so the toggle that writes a key and the `when` that reads
// it cannot name different variables.
const SETTINGS_REF: DisclosureRef = {
  variable: SETTINGS_ANCHOR,
  key: SETTINGS_ANCHOR,
  member: SETTINGS_OPEN,
};
const CONFIG_REF: DisclosureRef = {
  variable: CONFIG_SEG,
  key: CONFIG_SEG,
  member: SETTINGS_OPEN,
};

// ─── The tools menu and the doctor (brandon-doctor-b6a) ─────────────────────
//
// `🧰 tools` is `⚙ config`'s sibling: a disclosure inside the settings body
// holding the `🩺 doctor` button and, once it has run, one row per check. The
// report is SessionState (src/doctor/report.ts) read by `state` variables
// minted here from the same CHECKS list the fold runs over, so a second check
// is one more row in that list and no edit here [LAW:one-type-per-behavior].
// Its body is VERTICAL — one row per check, dropped under the tools row — so a
// long reason never widens the settings band it hangs from.
const TOOLS_SEG = `${SETTINGS_NS}tools`;
const TOOLS_REF: DisclosureRef = {
  variable: TOOLS_SEG,
  key: TOOLS_SEG,
  member: SETTINGS_OPEN,
};
// [LAW:one-source-of-truth] Undo and redo step the session's one settings
// history (src/daemon/settings-history.ts). Each button exists exactly while
// its stack has a step to take, read from the depth the daemon publishes every
// render (RenderPayload.history), so an undo on the bar always does something.
const HISTORY_STEPS: ReadonlyArray<{
  readonly seg: string;
  readonly depth: "undo" | "redo";
  readonly action: ActionDecl;
  readonly display: string;
}> = [
  {
    seg: `${SETTINGS_NS}undo`,
    depth: "undo",
    action: { undo: true },
    display: "↶ undo",
  },
  {
    seg: `${SETTINGS_NS}redo`,
    depth: "redo",
    action: { redo: true },
    display: "↷ redo",
  },
];
const historyDepthVar = (depth: string): string =>
  `${SETTINGS_NS}history.${depth}`;

const DOCTOR_SEG = `${SETTINGS_NS}doctor`;
const DOCTOR_RUN_ACTION = `${DOCTOR_SEG}.run`;
const doctorFixAction = (check: string): string => `${DOCTOR_SEG}.fix.${check}`;
const doctorRowSeg = (check: string): string => `${DOCTOR_SEG}.${check}`;

// [LAW:one-source-of-truth] One accordion key for every picker in the menu:
// one key holds one open member, so opening a theme picker closes the look
// picker. The settings menu is a narrow panel — two open drop-downs would
// overflow it — and this is the same shared-key mechanism group sugar uses,
// selected by a value, not a mode.
const PICKER_KEY = `${SETTINGS_NS}pickers`;

// [LAW:types-are-the-program] One row of the config menu, as data: everything
// that differs between "theme" and "padding" is a field here, so the six
// controls below are six VALUES and the synthesis that mints them is written
// once. A control names the two keys a setting has — the session key its pick
// writes and the config field its save and ↺ write (they differ where history
// made them differ — SessionState "theme" over globals field "palette") — the
// variable whose value it displays, and its value source.
//
// A control labels itself with its `effectiveVar` — the value the bar is
// ACTUALLY rendering with, whatever produced it — rather than with its own
// session key, so the label can never name a value the bar is not in.
interface SettingControl extends KeyedSetting {
  readonly glyph: string;
  readonly domain: OptionDomain;
  // [LAW:one-type-per-behavior] Every control offers its domain as a carousel
  // — a ring centred on the current value where every click applies
  // (brandon-theme-picker-bgw.ef6) — and `beneath` are the rows under the
  // ring, each a template: what sits under a ring is data a control carries,
  // not a kind of control.
  readonly beneath: readonly string[];
}

// The theme and look carousels share one preview: both choose the palette the
// bar is drawn in, and `{{ themePreview }}` samples exactly that palette.
const PALETTE_PREVIEW = ["{{ themePreview }}"];

// [LAW:one-type-per-behavior] Every picker setting, one control shape: a glyph,
// the current value, a picker over a domain, and the ↺ that returns it to the
// bundled default. They differ only in which keys they write and which domain they
// range — configuration, so they are VALUES of one synthesis, not hand-written
// segments. `theme`'s two keys differ (SessionState "theme" over
// globals field "palette") for the historical reason recorded in
// state-validators.ts's baseline table; carrying BOTH keys as data is what
// makes that difference expressible without a special case.
//
// They are split into two lists by WHERE they render, because that is a fact
// about each control, not something the layout should recover by comparing
// names [LAW:dataflow-not-control-flow]. Switching arrangement is what people
// open this menu for, so the preset carousel sits one click from the toggle;
// the display settings sit one disclosure deeper, which is what keeps the
// menu narrow when opened.
const PRIMARY_CONTROLS: readonly SettingControl[] = [
  {
    name: "preset",
    ...SETTINGS.preset,
    glyph: "▦",
    domain: "presets",
    // A preset changes the arrangement, and the tray this menu opens takes
    // over the door's row — so the bar cannot show its own first row while the
    // ring is open. `{{ layoutPreview }}` draws every row of it. Under it, the
    // presets the user makes (brandon-save-undo-bwi.o6u): keep the bar as a
    // new one, which the ring then shows current, and delete the one the ring
    // is on when the user made it.
    beneath: [
      "{{ layoutPreview }}",
      `{{ action "${PRESET_SAVE}" "⊕ save as preset" }}` +
        `{{ if not .preset.bundled }} ` +
        `{{ action "${PRESET_DELETE}" (printf "🗑 delete %s" .${SETTINGS.preset.effectiveVar}) }}` +
        `{{ end }}`,
    ],
  },
];

const CONFIG_CONTROLS: readonly SettingControl[] = [
  {
    name: "theme",
    ...SETTINGS.theme,
    glyph: "🎨",
    domain: "themes",
    beneath: PALETTE_PREVIEW,
  },
  {
    name: "look",
    ...SETTINGS.look,
    glyph: "◐",
    domain: "looks",
    beneath: PALETTE_PREVIEW,
  },
  {
    name: "style",
    ...SETTINGS.style,
    glyph: "✦",
    domain: "styles",
    beneath: [],
  },
  {
    name: "progression",
    ...SETTINGS.progression,
    glyph: "🎼",
    domain: "progressions",
    // A progression says which role each ROW wears, and the tray this menu
    // opens takes over the door's row — `{{ layoutPreview }}` draws every row,
    // each block in the tint the ring's current progression deals it.
    beneath: ["{{ layoutPreview }}"],
  },
  {
    name: "charset",
    ...SETTINGS.charset,
    glyph: "🔣",
    domain: "charsets",
    beneath: [],
  },
  {
    name: "colorCompatibility",
    ...SETTINGS.colorCompatibility,
    glyph: "🌈",
    domain: "colorCompatibilities",
    beneath: [],
  },
];

// The two settings whose affordance is not a picker: wrapping is a toggle (two
// members, so a menu would be a drop-down over a binary) and padding is a
// stepper over a range (16 picker cells for a value you nudge). Both are
// session writes exactly like the pickers — only the affordance differs, so
// they carry the same key record and only their `domain` is absent.
//
// [LAW:one-source-of-truth] Declared as records rather than typed inline at
// each use, so every key in SETTINGS_WRITTEN_KEYS below traces to one
// declaration. When these two were string literals repeated across the set,
// the segment and the action, a rename in one place would have silently
// misclassified the key rather than failing.
//
// Every control's keys are a row of SETTINGS (src/config/setting-projections.ts)
// spread in, never spelled here: the render derives its read-back from the same
// row, so a control cannot write a key whose current value nothing reads back.
interface KeyedSetting extends SettingProjection {
  readonly name: string;
}

const WRAP: KeyedSetting = { name: "wrap", ...SETTINGS.autoWrap };
const PADDING: KeyedSetting = { name: "padding", ...SETTINGS.padding };

const WRAP_SEG = `${SETTINGS_NS}${WRAP.name}`;
const PADDING_SEG = `${SETTINGS_NS}${PADDING.name}`;

// Every picker control, wherever it renders — minting one is the same job in
// both rows, so the synthesis folds over this and the placement lists above
// decide only where each lands.
const PICKER_CONTROLS: readonly SettingControl[] = [
  ...PRIMARY_CONTROLS,
  ...CONFIG_CONTROLS,
];

// [LAW:one-source-of-truth] Every control the menu mints, of every shape — the
// keys it writes and the resets `⟲ reset all` fires both read this one list.
const ALL_CONTROLS: readonly KeyedSetting[] = [
  ...PICKER_CONTROLS,
  WRAP,
  PADDING,
];

// [LAW:one-source-of-truth] Every PLAIN key the settings menu writes — the
// session key every control picks and the config field its save and ↺ write. Unlike the `candybar.` names, these
// are ordinary words a config can own (`theme`, `padding`, …), so a reader
// cannot tell from the key alone whether the menu or the author wrote it. This
// set is the menu's own answer to "which keys do I write", derived from the
// same records the controls are minted from, so a consumer pairing it with an
// authorship check (test/helpers/ambient-chrome.ts) can never drift from what
// the synthesis actually declares.
export const SETTINGS_WRITTEN_KEYS: ReadonlySet<string> = new Set(
  ALL_CONTROLS.flatMap((c) => [c.sessionKey, c.configKey]),
);

// [LAW:one-source-of-truth] A control's three names, derived from its one
// name — the segment that shows it, the action its picker applies, and the
// action its ↺ resets. Derived rather than declared so a control record can
// never name a segment whose picker writes a different setting.
const controlSeg = (name: string): string => `${SETTINGS_NS}${name}`;
const controlApply = (name: string): string => `${SETTINGS_NS}apply.${name}`;
const controlReset = (name: string): string => `${SETTINGS_NS}reset.${name}`;
const RESET_ALL = confirmStep(
  RESET_ALL_SEG,
  { arm: "⟲ reset all", confirm: "⟲ confirm reset all" },
  ALL_CONTROLS.map((c) => controlReset(c.name)),
);
// [LAW:one-source-of-truth] Every two-click step the door can bring into view,
// so the door disarms each of them without anyone remembering to list one.
const CONFIRMS = [RESET_ALL, COMMANDS] as const;
const controlCarousel = (name: string): string =>
  `${SETTINGS_NS}carousel.${name}`;
const controlBeneath = (name: string, row: number): string =>
  `${controlCarousel(name)}.${row}`;

// [LAW:one-source-of-truth] The one accordion every control's drop-down joins,
// as a disclosure ref per member, so two carousels are mutually exclusive
// through one key — and a `{{ menu }}` given the same shared key (menuStateKey)
// would join the same accordion rather than start a second convention.
const PICKERS_STATE_KEY = sharedMenuStateKey(PICKER_KEY);
const controlRef = (c: SettingControl): DisclosureRef => ({
  variable: PICKERS_STATE_KEY,
  key: PICKERS_STATE_KEY,
  member: menuMember(controlApply(c.name)),
});

// [LAW:dataflow-not-control-flow] Every control takes one place in the tree:
// its segment, with the carousel and the rows beneath it hung on it through
// the one disclosure lowering, dropped below the row the control sits in —
// what differs between controls is the record, never the shape.
function controlNode(c: SettingControl): LayoutNode {
  return disclosureNode(
    controlSeg(c.name),
    controlRef(c),
    {
      kind: "container",
      direction: "vertical",
      children: [
        { kind: "segment", name: controlCarousel(c.name) },
        ...c.beneath.map(
          (_, row): LayoutNode => ({
            kind: "segment",
            name: controlBeneath(c.name, row),
          }),
        ),
      ],
    },
    "drop",
  );
}

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
// The theorem includes the anchor inheriting no gate at all — a weaker stamp
// ("contains an anchor" alone) is what let a `when`-gated first row silently
// swallow the menu. The menu is visible under every condition: the default
// placement wraps a gated node rather than entering it, the root's own `when`
// included, and cross-ref rejects an authored placement under a gate
// (`anchorUnderGate`).
type AnchoredRoot = LayoutNode & { readonly [anchored]: true };

// [LAW:dataflow-not-control-flow] The default position, as structural recursion
// over the LayoutNode union rather than a placement mode: descend to the bar's
// FIRST horizontal row and take the LEADING cell there — the bar's first item,
// a fixed corner the eye and the mouse find without reading the row, and the
// one position that does not drift as a config's content grows to its right.
// Total over every tree shape, including the degenerate ones: a bare-segment
// root (the A-grammar collapses a lone top-level ref) grows a horizontal
// wrapper, and an empty container renders the door alone.
//
// [LAW:no-silent-failure] A gated node is wrapped, never entered, so the door
// never inherits the author's gate. A gated row is led from outside its gate,
// on the same line. A gated stack gets the door on its own row above it,
// because leading the stack would put every row under the door's inline claim.
function prependAnchor(node: LayoutNode): LayoutNode {
  const anchorRef: LayoutNode = { kind: "segment", name: SETTINGS_ANCHOR };
  if (node.kind === "container" && node.direction === "vertical") {
    const [first, ...rest] = node.children;
    return node.when === undefined && first !== undefined
      ? { ...node, children: [prependAnchor(first), ...rest] }
      : {
          kind: "container",
          direction: "vertical",
          children: [anchorRef, node],
        };
  }
  return node.kind === "container" && node.when === undefined
    ? { ...node, children: [anchorRef, ...node.children] }
    : {
        kind: "container",
        direction: "horizontal",
        children: [anchorRef, node],
      };
}

// [LAW:parse-dont-validate] The checkpoint: in, a tree that may or may not name
// the anchor; out, a tree that provably does. The author's placement passes
// through byte-identical — the position they chose IS the answer — and its
// absence is answered with the default position. One value, two sources.
function withAnchor(node: LayoutNode): AnchoredRoot {
  const placed = countAnchors(node) > 0 ? node : prependAnchor(node);
  return placed as AnchoredRoot;
}

// [LAW:single-enforcer] THE anchor census, read by both consumers of the count:
// `withAnchor` (is there a placement to honor?) and the loader's duplicate check
// (is there more than one?). One traversal definition, so "placed" cannot mean
// different things to the two.
export function countAnchors(node: LayoutNode): number {
  let n = 0;
  for (const each of walkNodes(node)) {
    if (each.kind === "segment" && isSettingsAnchor(each.name)) n += 1;
  }
  return n;
}

// [LAW:single-enforcer] THE gate census for an authored placement: does an
// anchor sit under a `when` or inside a disclosure body? Read by cross-ref,
// which rejects it — the menu is visible under every condition.
export function anchorUnderGate(node: LayoutNode, gated = false): boolean {
  const here = gated || node.when !== undefined;
  if (node.kind === "segment") {
    return (
      (here && isSettingsAnchor(node.name)) ||
      (node.opens !== undefined && anchorUnderGate(node.opens.body, true))
    );
  }
  return node.children.some((child) => anchorUnderGate(child, here));
}

// [LAW:one-type-per-behavior] The lowering, THE one every disclosure takes
// (`disclosureNode`, as lowerGroup): the anchor leaf becomes the toggle with
// the menu's body hung on it, wherever it sits, so the author's chosen
// position is the menu's position with nothing else moved. The door opens
// INLINE: its body's first row takes the door's own row. The `⚙ config`
// row is a disclosure INSIDE that body — nesting is structure, not a second
// gate: a config row left open yesterday cannot render beside a closed menu
// today because it hangs on a trigger the closed menu does not render. The
// walk colours the body on the door's band and the config row on the
// band ⚙ opens one depth further (candybar-render-ai7.9).
function expandAnchor(node: AnchoredRoot | LayoutNode): LayoutNode {
  if (node.kind === "segment") {
    return isSettingsAnchor(node.name)
      ? disclosureNode(
          node.name,
          SETTINGS_REF,
          // What the menu is FOR — the quick-action tray, the preset
          // switcher and, beside it while there is something to save, the
          // save cell; the door into the config menu, the door into edit
          // mode, and the history's undo/redo.
          {
            kind: "container",
            direction: "horizontal",
            children: [
              { kind: "segment", name: TOOLBAR_SEG },
              { kind: "segment", name: COMMANDS_SEG },
              ...PRIMARY_CONTROLS.map(controlNode),
              { kind: "segment", name: SAVE_SEG },
              // The display settings, behind their own disclosure so the
              // menu opens narrow.
              disclosureNode(
                CONFIG_SEG,
                CONFIG_REF,
                {
                  kind: "container",
                  direction: "horizontal",
                  children: [
                    ...CONFIG_CONTROLS.map(controlNode),
                    { kind: "segment", name: WRAP_SEG },
                    { kind: "segment", name: PADDING_SEG },
                    { kind: "segment", name: RESET_ALL_SEG },
                  ],
                },
                "drop",
              ),
              // The tools, behind their own disclosure: the doctor button,
              // then one row per check once it has run.
              disclosureNode(
                TOOLS_SEG,
                TOOLS_REF,
                {
                  kind: "container",
                  direction: "vertical",
                  children: [
                    { kind: "segment", name: DOCTOR_SEG },
                    ...CHECKS.map(
                      (c): LayoutNode => ({
                        kind: "segment",
                        name: doctorRowSeg(c.name),
                      }),
                    ),
                  ],
                },
                "drop",
              ),
              { kind: "segment", name: EDIT_SEG },
              ...HISTORY_STEPS.map(
                (h): LayoutNode => ({ kind: "segment", name: h.seg }),
              ),
            ],
          },
          "inline",
        )
      : node;
  }
  return expandContainer(node);
}

function expandContainer<
  N extends { readonly children: readonly LayoutNode[] },
>(node: N): N {
  return {
    ...node,
    children: node.children.map((child) => expandAnchor(child)),
  };
}

// ─── The artifacts ──────────────────────────────────────────────────────────

interface MenuArtifacts {
  readonly variables: Record<string, VariableDecl>;
  readonly actions: Record<string, ActionDecl>;
  readonly segments: Record<string, SegmentDecl>;
}

// [LAW:one-source-of-truth] Everything the menu is, minted ONCE per config and
// merely REFERENCED from each preset root. This is what makes the pass
// idempotent across N presets for free: a preset root carries a segment
// reference, and a second reference to one declaration is a reuse, not the
// self-collision a second `kind: "group"` node would be: group names are one
// synthesis-wide namespace, so a group embedded in two preset roots declares
// itself twice.
function settingsArtifacts(doorGlyph: string): MenuArtifacts {
  const artifacts: MenuArtifacts = {
    variables: {
      [SETTINGS_ANCHOR]: disclosureStateVar(SETTINGS_ANCHOR, DISCLOSURE_CLOSED),
    },
    actions: {
      [DOOR_TOGGLE]: disclosureCycleAction(SETTINGS_ANCHOR, SETTINGS_OPEN),
      [SETTINGS_ANCHOR]: {
        do: [DOOR_TOGGLE, ...CONFIRMS.map((c) => c.disarm)],
      },
      [CONFIG_TOGGLE]: disclosureCycleAction(CONFIG_SEG, SETTINGS_OPEN),
      [CONFIG_SEG]: { do: [CONFIG_TOGGLE, RESET_ALL.disarm] },
      [TOOLS_SEG]: disclosureCycleAction(TOOLS_SEG, SETTINGS_OPEN),
      [DOCTOR_RUN_ACTION]: { doctor: "run" },
      // [LAW:composability] Entering or leaving edit mode is a trip OUT of the
      // menu: the menu opens inline over the door's row, so edit mode's chrome
      // for that row is hidden until the menu closes. The edit control is
      // therefore the toggle and the close fired as one click, composed from
      // two ordinary actions — the close is a literal write to the key the
      // door's own cycle writes, so each carries the gate it always carried.
      [SETTINGS_CLOSE]: { set: SETTINGS_REF.key, to: DISCLOSURE_CLOSED },
      [EDIT_SEG]: { do: [EDIT_TOGGLE_ACTION, SETTINGS_CLOSE] },
      ...TOOLBAR.actions,
      ...COMMANDS.actions,
      [SAVE_SEG]: { save: true },
      [PRESET_SAVE]: { preset: "save" },
      [PRESET_DELETE]: {
        preset: "delete",
        name: `{{ .${SETTINGS.preset.effectiveVar} }}`,
      },
    },
    segments: {
      // [LAW:representation] ONE symbol per state, unlike the labelled toggles
      // below, which are a word plus the ▸/▾ that gates it. The door has no
      // label to gate: it is a glyph, so a second glyph beside it would be the
      // only thing on the bar that spells its state twice. The door's glyph
      // names what it opens, `❌` names what the click does.
      //
      // Two displays through the same `[closed, member]` cycle every other
      // disclosure binds: the shape did not change, only the values.
      [SETTINGS_ANCHOR]: {
        template: disclosureTrigger(
          SETTINGS_ANCHOR,
          doorGlyph,
          DOOR_CLOSE_GLYPH,
        ),
      },
      [TOOLBAR_SEG]: { template: TOOLBAR.template },
      [COMMANDS_SEG]: { template: COMMANDS.template },
      // [LAW:dataflow-not-control-flow] The cell exists exactly while there is
      // something to save — `gt` renders the literal "false" at zero, the only
      // text a `when` hides on — and it says how much, so a click never
      // commits more than the user can see is pending.
      [SAVE_SEG]: {
        when: `{{ gt .${UNSAVED_VAR} 0 }}`,
        template: `{{ action "${SAVE_SEG}" (printf "💾 save %d" .${UNSAVED_VAR}) }}`,
      },
      [CONFIG_SEG]: {
        template: disclosureTrigger(
          CONFIG_SEG,
          `⚙ config ${DISCLOSURE_GLYPH_CLOSED}`,
          `⚙ config ${DISCLOSURE_GLYPH_OPEN}`,
        ),
      },
      [TOOLS_SEG]: {
        template: disclosureTrigger(
          TOOLS_SEG,
          `🧰 tools ${DISCLOSURE_GLYPH_CLOSED}`,
          `🧰 tools ${DISCLOSURE_GLYPH_OPEN}`,
        ),
      },
      [DOCTOR_SEG]: {
        template: `{{ action "${DOCTOR_RUN_ACTION}" "🩺 doctor" }}`,
      },
      // [LAW:one-type-per-behavior] Both non-picker controls read the same
      // `.effective` projection their picker siblings read, and write the
      // session exactly as they do — a toggle and a stepper are affordances
      // over one behavior, not two kinds of setting.
      [WRAP_SEG]: {
        template:
          `{{ action "${controlApply("wrap")}" "wrap: on" "wrap: off" }} ` +
          `{{ action "${controlReset("wrap")}" "↺" }}`,
      },
      [PADDING_SEG]: {
        template:
          `{{ action "${controlApply("padding")}.down" "◀" }} ` +
          `padding {{ .${PADDING.effectiveVar} }} ` +
          `{{ action "${controlApply("padding")}.up" "▶" }} ` +
          `{{ action "${controlReset("padding")}" "↺" }}`,
      },
      [EDIT_SEG]: {
        template: `{{ action "${EDIT_SEG}" "✎ edit" "✎ done" }}`,
      },
      [RESET_ALL_SEG]: { template: RESET_ALL.template },
    },
  };
  // The count the daemon publishes every render (RenderPayload.unsaved).
  artifacts.variables[UNSAVED_VAR] = {
    kind: "input",
    path: "unsaved",
    type: "number",
    default: 0,
  };
  artifacts.variables[CONFIG_SEG] = disclosureStateVar(
    CONFIG_SEG,
    DISCLOSURE_CLOSED,
  );
  artifacts.variables[TOOLS_SEG] = disclosureStateVar(
    TOOLS_SEG,
    DISCLOSURE_CLOSED,
  );
  Object.assign(artifacts.variables, COMMANDS.variables, RESET_ALL.variables);
  declareSettingControls(artifacts);
  declareDoctorRows(artifacts);
  declareHistorySteps(artifacts);
  return artifacts;
}

function declareHistorySteps(artifacts: MenuArtifacts): void {
  for (const h of HISTORY_STEPS) {
    const depth = historyDepthVar(h.depth);
    artifacts.variables[depth] = {
      kind: "input",
      path: `history.${h.depth}`,
      type: "number",
      default: 0,
    };
    artifacts.actions[h.seg] = h.action;
    artifacts.segments[h.seg] = {
      when: `{{ gt .${depth} 0 }}`,
      template: `{{ action "${h.seg}" "${h.display}" }}`,
    };
  }
}

// [LAW:one-source-of-truth] One report row per check, minted from the CHECKS
// list the doctor folds over, its keys from the SAME `doctorReportKeys` the
// doctor verbs write through. A row exists exactly when its check has run
// (`verdict` left its unrun default); it reads `✓ label`, or `✗ label — reason`
// with a `[fix]` bound to that check's own fix action when the verdict carried
// one. The `[fix]` is `{ doctor: "fix", check }` — the daemon re-probes the
// check at click time and refuses loudly if there is nothing left to fix.
function declareDoctorRows(artifacts: MenuArtifacts): void {
  for (const c of CHECKS) {
    const keys = doctorReportKeys(c.name);
    const fix = doctorFixAction(c.name);
    for (const key of Object.values(keys)) {
      artifacts.variables[key] = { kind: "state", key, default: VERDICT_UNRUN };
    }
    artifacts.actions[fix] = { doctor: "fix", check: c.name };
    artifacts.segments[doctorRowSeg(c.name)] = {
      when: `{{ ne .${keys.verdict} "${VERDICT_UNRUN}" }}`,
      template:
        `{{ if eq .${keys.verdict} "${VERDICT_OK}" }}✓ ${c.label}` +
        `{{ else }}✗ ${c.label} — {{ .${keys.reason} }}` +
        `{{ if eq .${keys.fixable} "${BOOLEAN_TRUE}" }} {{ action "${fix}" "[fix]" }}{{ end }}` +
        `{{ end }}`,
    };
  }
}

// [LAW:one-source-of-truth] Every setting the menu offers, minted from the one
// table that describes them. A picker control is a glyph, its live value, the
// toggle that opens its carousel over its domain, and the ↺ that returns it to
// bundled default; wrap and padding are a cycle and a stepper instead. Every
// apply action here is a session `set` — a draft the save cell commits.
//
// A pick leaves its carousel open, re-centred on what it applied
// (brandon-theme-picker-bgw.etd): choosing a theme is trying several, so each
// try must not cost a reopen; ✕ closes. That holds for a preset pick too,
// whose click swaps the whole root — the menu survives it because every
// preset root references this one anchor and both open states are session
// keys, not tree positions.
//
// [LAW:single-enforcer] Nothing here declares a gate. `deriveActionValidators`
// derives each session key's gate from these `set`s, and a save re-validates
// every draft through that same gate before it touches the file.
function declareSettingControls(artifacts: MenuArtifacts): void {
  for (const c of PICKER_CONTROLS) {
    const apply = controlApply(c.name);
    artifacts.actions[apply] = { set: c.sessionKey, from: c.domain };
    // [LAW:one-source-of-truth] ↺ returns the setting to its bundled default:
    // the session's pick and every layer of the config file a save can write
    // (resetLayers, src/daemon/setting-drafts.ts). Its key is the config key a
    // save writes, read from the same record, so the two can never name
    // different settings.
    artifacts.actions[controlReset(c.name)] = { reset: c.configKey };
    declareControlRow(c, artifacts);
  }
  artifacts.actions[controlApply(WRAP.name)] = {
    set: WRAP.sessionKey,
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
      ...PADDING_RANGE,
      by,
    };
  }
  artifacts.actions[controlReset(PADDING.name)] = { reset: PADDING.configKey };
  Object.assign(artifacts.actions, RESET_ALL.actions);
}

// [LAW:one-type-per-behavior] Every picker control mints the same row — the
// glyph, the value the bar is rendering with, the toggle that opens its
// carousel on the shared accordion key, the ↺ — and the carousel's own rows as
// segments of their own.
function declareControlRow(c: SettingControl, artifacts: MenuArtifacts): void {
  const apply = controlApply(c.name);
  const ref = controlRef(c);
  const toggle = menuActionName(ref.key, ref.member);
  artifacts.variables[ref.key] = disclosureStateVar(ref.key, DISCLOSURE_CLOSED);
  artifacts.actions[toggle] = disclosureCycleAction(ref.key, ref.member);
  artifacts.segments[controlSeg(c.name)] = {
    template:
      `${c.glyph} {{ .${c.effectiveVar} }} ` +
      `${disclosureTrigger(toggle, DISCLOSURE_GLYPH_CLOSED, DISCLOSURE_GLYPH_OPEN)} ` +
      `{{ action "${controlReset(c.name)}" "↺" }}`,
  };
  artifacts.segments[controlCarousel(c.name)] = {
    template: `{{ carousel "${apply}" }}`,
  };
  c.beneath.forEach((template, i) => {
    artifacts.segments[controlBeneath(c.name, i)] = { template };
  });
}

// [LAW:one-source-of-truth] Edit mode's toggle, ensured rather than duplicated:
// both this pass and synthesizeEditModeToggle produce it by calling the same two
// disclosure functions on the same two exported constants, so the two mints are
// the same value by construction and whichever lands first is the only one.
// Ensuring it here is not an optional courtesy — the EDIT_SEG action above
// fires `edit.toggle`, and that pass is demand-driven off a scan of the
// segments a FILE declared, which cannot see a segment this pass mints later.
function ensureEditToggle(artifacts: MenuArtifacts): void {
  artifacts.variables[EDIT_MODE_KEY] = disclosureStateVar(
    EDIT_MODE_KEY,
    DISCLOSURE_CLOSED,
  );
  artifacts.actions[EDIT_TOGGLE_ACTION] = disclosureCycleAction(
    EDIT_MODE_KEY,
    EDIT_MODE_ARRANGE,
  );
}

// [LAW:single-enforcer] THE synthesis entry point, called once from
// validateConfig after cross-ref/cycle checks pass and before edit chrome.
// Every declared preset — the floor `default` included — gets an explicit
// `presets[name].root` carrying its anchored, expanded tree; `config.root`
// itself is left untouched, exactly as synthesizeEditChrome leaves it, because
// presetRoot falls back to it only for a preset declaring no root of its own
// and every name now declares one.
//
// There is no precondition (brandon-settings-menu-d6f: "The settings menu
// should always be visible no matter what"): whatever the menu reads that the
// config does not declare, it ensures — merged UNDER the config, so a user's
// own declaration of the same name wins, exactly as edit chrome's ensured
// inputs do.
export function synthesizeSettingsMenu(config: DslConfig): DslConfig {
  const artifacts = settingsArtifacts(config.globals.menuGlyph ?? DOOR_GLYPH);
  ensureEditToggle(artifacts);
  const presets: Record<string, PresetDecl> = { ...config.presets };
  const roots: LayoutNode[] = [];
  for (const name of presetNames(config.presets)) {
    const { node } = presetRoot(config, name);
    const root = expandAnchor(withAnchor(node));
    roots.push(root);
    presets[name] = { ...presetByName(config.presets, name), root };
  }
  const ensured = synthesisInputs(artifacts, roots, config);
  return {
    ...config,
    variables: { ...ensured, ...config.variables, ...artifacts.variables },
    actions: { ...config.actions, ...artifacts.actions },
    segments: { ...config.segments, ...artifacts.segments },
    presets,
  };
}
