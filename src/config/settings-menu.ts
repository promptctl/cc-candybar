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
//     `✓ done` fires — so the ordering is load-bearing in that direction too,
//     not merely tidy.

import { ident } from "./ident.js";
import type { ActionDecl } from "./action.js";
import {
  walkNodes,
  type ContainerNode,
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
import { EDIT_SWITCH, editModeArtifacts } from "./loader/edit-mode.js";
import { menuActionName, menuMember, sharedMenuStateKey } from "./menu-keys.js";
import { presetByName, presetNames, presetRoot } from "./presets.js";
import { quickActions } from "./quick-actions.js";
import { commandTray } from "./command-tray.js";
import { confirmStep } from "./confirm-step.js";
import { SETTINGS_NS } from "./loader/reserved-namespace.js";
import {
  SETTINGS,
  type SettingName,
  type SettingProjection,
} from "./setting-projections.js";
import { synthesisInputs } from "./synthesis-inputs.js";
import { BOOLEAN_TRUE } from "../themes/policy.js";
import { globalsControlDomain } from "./loader/globals.js";
import { settingControl, type Affordance } from "./setting-control.js";

// [LAW:one-source-of-truth] THE anchor: one string that is simultaneously the
// segment name an author places in `root` to choose the menu's position, the
// name of the toggle segment the synthesis puts there, the disclosure's state
// variable, and its cycle action. Group sugar already spans those four with one
// `groups.<name>` string for the same reason — one name means the toggle's
// click and the body's `when` cannot address different keys.
export const SETTINGS_ANCHOR = `${SETTINGS_NS}menu`;

// The open member of every binary disclosure this menu mints — each holds the
// CLOSED sentinel or this. The tab key is the accordion exception: it holds
// the open tab's name.
export const SETTINGS_OPEN = "open";

// The body's content segments.
const EDIT_SEG = `${SETTINGS_NS}edit`;
const SETTINGS_CLOSE = `${SETTINGS_NS}close`;
const TOOLBAR_SEG = `${SETTINGS_NS}toolbar`;
const TOOLBAR = quickActions(SETTINGS_NS);
const COMMANDS_SEG = `${SETTINGS_NS}commands`;
const COMMANDS = commandTray(`${COMMANDS_SEG}.`);

// ─── The tabs (brandon-menu-tabs-wnu.qqz) ───────────────────────────────────
//
// [LAW:one-type-per-behavior] The door's second line is five tabs, one open at
// a time, its body dropped below the strip. A tab strip is an accordion: every
// tab is a disclosure trigger on ONE key, which holds the open tab's name, so
// opening one closes the rest and the open one wears its state colour like any
// open trigger. The door's click folds it back to the first tab (doorFolds),
// so the menu always reopens at its top level.
const TAB_KEY = `${SETTINGS_NS}tab`;
const TABS = [
  { member: "session", label: "⚡ session" },
  { member: "look", label: "🎨 look" },
  // `📐`, because `▦` is the preset control's glyph.
  { member: "layout", label: "📐 layout" },
  { member: "config", label: "⚙ config" },
  { member: "tools", label: "🧰 tools" },
] as const;
type TabName = (typeof TABS)[number]["member"];
// The tab a fresh session opens the menu on.
const FIRST_TAB: TabName = "session";
const tabSeg = (tab: TabName): string => `${TAB_KEY}.${tab}`;
// A tab's own open/close cycle, fired by the tab's click beside the disarms.
const tabToggle = (tab: TabName): string => `${tabSeg(tab)}.toggle`;
const tabRef = (tab: TabName): DisclosureRef => ({
  variable: TAB_KEY,
  key: TAB_KEY,
  member: tab,
});

// ─── The config menu (candybar-settings-ui-aok.3) ───────────────────────────
//
// [LAW:one-source-of-truth] ONE control per setting, and every control writes
// the session: a pick is a DRAFT until it is saved (brandon-save-undo-bwi.hpi).
// The drafts are derived, never flagged — src/daemon/setting-drafts.ts compares
// the session with what the config file resolves — and `💾 save N` exists
// exactly while there are N of them, writing all of them to the file in one
// click. There is no destination selector to consult: where a click lands is
// the same place every time, and saving is its own, visible act.
// Exported because edit mode's `✓ save` fires this same save and reads this
// same count (src/config/edit-chrome.ts): the menu is in every config, and
// is synthesized before edit chrome.
export const SAVE_SEG = `${SETTINGS_NS}save`;
export const UNSAVED_VAR = `${SETTINGS_NS}unsaved`;

// ─── Presets the user makes (brandon-save-undo-bwi.o6u) ─────────────────────
const PRESET_SAVE = `${SETTINGS_NS}preset.save`;
const PRESET_DELETE = `${SETTINGS_NS}preset.delete`;

// ─── Reset all (brandon-save-undo-bwi.wt5) ──────────────────────────────────
//
// [LAW:composability] `⟲ reset all` is every control's ↺ fired as one click —
// a `do` over the resets the controls already declare, so it cannot reset a
// setting differently from that setting's own ↺, and one click is one step in
// the undo history. It takes two clicks: the first arms it (a session key), the
// second fires. The door — the only way into the save cell — disarms it, so
// the confirming click is always made in the view the arming click was made
// in, however that view was later closed.
const RESET_ALL_SEG = `${SETTINGS_NS}resetAll`;
// The door's own open/close cycle, fired beside the disarm.
const DOOR_TOGGLE = `${SETTINGS_ANCHOR}.toggle`;

// [LAW:one-source-of-truth] The door's disclosure as a ref rather than a gate
// string (each tab's is `tabRef`): every gate below — and every `(?)` nested
// inside them — derives from a ref, so the toggle that writes a key and the
// `when` that reads it cannot name different variables.
const SETTINGS_REF: DisclosureRef = {
  variable: SETTINGS_ANCHOR,
  key: SETTINGS_ANCHOR,
  member: SETTINGS_OPEN,
};

// Undo and redo step the session's one settings history
// (src/daemon/settings-history.ts).
const UNDO_ACTION = `${SETTINGS_NS}undo`;
// [LAW:one-source-of-truth] `◁` restores what the session's last navigating
// click opened or closed (src/daemon/navigation-history.ts). It leads the
// menu's first line, right after the risen door, and is always drawn — quiet
// and inert while there is nothing to go back to — so nothing after it moves.
const BACK_ACTION = `${SETTINGS_NS}back`;
const BACK_STEP = `${BACK_ACTION}.step`;
const BACK_COUNT = `${SETTINGS_NS}navigation.back`;
const BACK_SEG = BACK_ACTION;
const BACK_GLYPH = "◁";
const BACK_QUIET_FG = `(readableOn (mix (contrastOn (bgOf)) (bgOf) 60) (bgOf) 3)`;
const BACK_CELL: SegmentDecl = {
  template:
    `{{ if gt .${BACK_COUNT} 0 }}{{ action "${BACK_ACTION}" "${BACK_GLYPH}" }}` +
    `{{ else }}{{ fg ${BACK_QUIET_FG} "${BACK_GLYPH}" }}{{ end }}`,
};
const REDO_ACTION = `${SETTINGS_NS}redo`;
// How many settings a reset all would change (RenderPayload.resettable).
const RESETTABLE_VAR = `${SETTINGS_NS}resettable`;

// ─── The doctor (brandon-doctor-b6a) ────────────────────────────────────────
//
// The `🧰 tools` tab holds the `🩺 doctor` button and, once it has run, one row
// per check. The report is SessionState (src/doctor/report.ts) read by `state`
// variables minted here from the same CHECKS list the fold runs over, so a
// second check is one more row in that list and no edit here
// [LAW:one-type-per-behavior]. The body is VERTICAL — one row per check — so a
// long reason never widens the band it hangs from.
const DOCTOR_SEG = `${SETTINGS_NS}doctor`;
const DOCTOR_RUN_ACTION = `${DOCTOR_SEG}.run`;
const doctorFixAction = (check: string): string => `${DOCTOR_SEG}.fix.${check}`;
const doctorRowSeg = (check: string): string => `${DOCTOR_SEG}.${check}`;

// [LAW:one-source-of-truth] One accordion key for every picker in the menu:
// one key holds one open member, so opening a theme picker closes the style
// picker. The settings menu is a narrow panel — two open drop-downs would
// overflow it — and this is the same shared-key mechanism group sugar uses,
// selected by a value, not a mode.
const PICKER_KEY = `${SETTINGS_NS}pickers`;

// The theme and style carousels share one preview: both choose the palette the
// bar is drawn in, and `{{ themePreview }}` samples exactly that palette.
const PALETTE_PREVIEW: readonly SegmentDecl[] = [
  { template: "{{ themePreview }}" },
];
const LAYOUT_PREVIEW: SegmentDecl = { template: "{{ layoutPreview }}" };

// [LAW:types-are-the-program] What hangs under a control's carousel, beyond
// the ring itself — each a row. A ring shows neighbours of the current value;
// these show what picking one does to the bar.
const BENEATH: Partial<Record<SettingName, readonly SegmentDecl[]>> = {
  // A preset changes the arrangement: `{{ layoutPreview }}` draws every row
  // of it, one block per segment, named. Under it, while the ring is on a
  // preset the user made (brandon-save-undo-bwi.o6u), the click that deletes
  // it; `+ preset` in the 📐 layout tab makes one.
  preset: [
    LAYOUT_PREVIEW,
    {
      when: "{{ not .preset.bundled }}",
      template: `{{ action "${PRESET_DELETE}" (printf "🗑 delete %s" .${SETTINGS.preset.effectiveVar}) }}`,
    },
  ],
  theme: PALETTE_PREVIEW,
  style: PALETTE_PREVIEW,
  // A variation says which role each ROW wears — `{{ layoutPreview }}`
  // draws every row, each block in the tint the ring's current variation
  // deals it.
  variation: [LAYOUT_PREVIEW],
};

// [LAW:one-source-of-truth] A control's names, derived from its setting's
// name — the segment that shows it, the action it writes through, and the
// action its ↺ resets — so a control can never name a segment whose action
// writes a different setting.
const controlSeg = (name: string): string => `${SETTINGS_NS}${name}`;
const controlApply = (name: string): string => `${SETTINGS_NS}apply.${name}`;
const controlReset = (name: string): string => `${SETTINGS_NS}reset.${name}`;
const controlCarousel = (name: string): string =>
  `${SETTINGS_NS}carousel.${name}`;
const controlBeneath = (name: string, row: number): string =>
  `${controlCarousel(name)}.${row}`;

// One control of the menu: its setting's row of SETTINGS and what the
// generator made of that setting's declared domain.
interface MenuControl extends SettingProjection {
  readonly name: SettingName;
  readonly control: Affordance;
  readonly beneath: readonly SegmentDecl[];
}

// [LAW:one-source-of-truth] Every setting the menu offers, generated
// (brandon-settings-coverage-g4p.zoj): one control per row of SETTINGS, its
// shape — a toggle, a stepper, a carousel — decided by the domain the loader
// declares for the field beside its spec (`globalsControlDomain`), through the
// same generator configure mode uses for a placement's settings. Every apply
// action is a session `set`: a draft until the save cell commits it.
//
// [LAW:no-silent-failure] A row naming a field no control shape fits is a
// programming error, refused the moment this module loads.
const CONTROLS: readonly MenuControl[] = (
  Object.keys(SETTINGS) as SettingName[]
).map((name) => {
  const row: SettingProjection = SETTINGS[name];
  const domain = globalsControlDomain(row.configKey);
  if (domain === "text") {
    throw new Error(
      `settings menu: globals.${row.configKey} is free text, which no control can change — list it in UNCONTROLLED_GLOBALS instead of SETTINGS`,
    );
  }
  const control = settingControl(
    { label: row.label, domain },
    row.sessionKey,
    row.effectiveVar,
    controlApply(name),
  );
  return { ...row, name, control, beneath: BENEATH[name] ?? [] };
});

// [LAW:types-are-the-program] Where each setting's control renders — the
// door's first line, or exactly one tab — as a record keyed by every setting,
// so a new setting is a compile error until it is given a place. Switching
// arrangement is what people open this menu for, so the preset control sits on
// the door's first line, one click from the door.
const PLACE: Readonly<Record<SettingName, "door" | TabName>> = {
  preset: "door",
  theme: "look",
  style: "look",
  variation: "look",
  endcaps: "look",
  autoWrap: "layout",
  padding: "layout",
  charset: "config",
  colorCompatibility: "config",
  updateNotice: "config",
};
const controlsAt = (place: "door" | TabName): LayoutNode[] =>
  CONTROLS.filter((c) => PLACE[c.name] === place).map(controlNode);

// [LAW:one-source-of-truth] Every PLAIN key the settings menu writes — the
// session key every control picks and the config field its save and ↺ write.
// Unlike the `candybar.` names, these are ordinary words a config can own
// (`theme`, `padding`, …), so a reader cannot tell from the key alone whether
// the menu or the author wrote it. This set is the menu's own answer to "which
// keys do I write", derived from the same rows the controls are minted from,
// so a consumer pairing it with an authorship check
// (test/helpers/ambient-chrome.ts) can never drift from what the synthesis
// actually declares.
export const SETTINGS_WRITTEN_KEYS: ReadonlySet<string> = new Set(
  CONTROLS.flatMap((c) => [c.sessionKey, c.configKey]),
);

const RESET_ALL = confirmStep(
  RESET_ALL_SEG,
  { arm: "⟲", confirm: "⟲ reset all?" },
  CONTROLS.map((c) => controlReset(c.name)),
);

// ─── The save cell ──────────────────────────────────────────────────────────
//
// [LAW:one-source-of-truth] `💾 save 3 ↶ ↷ ⟲` — one cell beside the preset,
// each part present exactly while it has something to do, read from a count
// the daemon publishes every render: save while there are drafts, undo and
// redo while their stack has a step, `⟲` while a reset all would change
// something (a draft, or a value the config file holds at a layer a reset
// clears) or while it is armed, so its confirm is never hidden armed. So a
// click on any part always does something.
interface SavePart {
  readonly count: string;
  readonly path: string;
  readonly body: string;
  readonly shown: string;
}
const counted = (count: string, path: string, body: string): SavePart => ({
  count,
  path,
  body,
  shown: `(gt .${count} 0)`,
});
const SAVE_PARTS: readonly SavePart[] = [
  counted(
    UNSAVED_VAR,
    "unsaved",
    `{{ action "${SAVE_SEG}" (printf "💾 save %d" .${UNSAVED_VAR}) }}`,
  ),
  counted(
    `${SETTINGS_NS}history.undo`,
    "history.undo",
    `{{ action "${UNDO_ACTION}" "↶" }}`,
  ),
  counted(
    `${SETTINGS_NS}history.redo`,
    "history.redo",
    `{{ action "${REDO_ACTION}" "↷" }}`,
  ),
  {
    count: RESETTABLE_VAR,
    path: "resettable",
    body: RESET_ALL.template,
    shown: `(or (gt .${RESETTABLE_VAR} 0) ${RESET_ALL.armed})`,
  },
];
// The parts present, one space between each: `$sep` is empty until the first
// part renders.
// [LAW:dataflow-not-control-flow] The gate is a boolean `or` of booleans: a
// `when` hides only on the literal "false", so an `or` over bare counts would
// render "0" and show an empty cell.
const SAVE_CELL: SegmentDecl = {
  when: `{{ or ${SAVE_PARTS.map((p) => p.shown).join(" ")} }}`,
  template:
    `{{ $sep := "" }}` +
    SAVE_PARTS.map(
      (p) => `{{ if ${p.shown} }}{{ $sep }}${p.body}{{ $sep = " " }}{{ end }}`,
    ).join(""),
};
// [LAW:one-source-of-truth] Every two-click step the menu holds, with the view
// it sits in. Every click that can bring a confirm into view disarms it — the
// door every one, a tab click every one that sits in a tab — so a confirm is
// only ever made in the view its arming click was made in, however it left
// view (a body's ✕ only closes), and one that never leaves view (`⟲` on the
// door's first line) stays armed across tab clicks.
const CONFIRMS = [
  { step: RESET_ALL, place: "door" },
  { step: COMMANDS, place: "session" },
] as const satisfies ReadonlyArray<{
  readonly step: { readonly disarm: string };
  readonly place: "door" | TabName;
}>;
const disarms = (out: ReadonlyArray<(typeof CONFIRMS)[number]>): string[] =>
  out.map((c) => c.step.disarm);
const DOOR_DISARMS = disarms(CONFIRMS);
const TAB_DISARMS = disarms(CONFIRMS.filter((c) => c.place !== "door"));

// [LAW:one-source-of-truth] The one accordion every control's carousel joins,
// as a disclosure ref per member, so two carousels are mutually exclusive
// through one key, and a `{{ menu }}` given the same shared key (menuStateKey)
// would join the same accordion rather than start a second convention.
const PICKERS_STATE_KEY = sharedMenuStateKey(PICKER_KEY);
const controlRef = (name: string): DisclosureRef => ({
  variable: PICKERS_STATE_KEY,
  key: PICKERS_STATE_KEY,
  member: menuMember(controlApply(name)),
});

// [LAW:dataflow-not-control-flow] Every control takes one place in the tree,
// decided by what the generator made of it: an inline control is its own
// cell; a ring hangs its carousel and the rows beneath it on the control
// through the one disclosure lowering, dropped below the row it sits in.
function controlNode(c: MenuControl): LayoutNode {
  const self = controlSeg(c.name);
  return c.control.kind === "inline"
    ? { kind: "segment", name: self }
    : disclosureNode(
        self,
        controlRef(c.name),
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
// on the same line. A gated stack gets the door on its own row above it.
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

// [LAW:one-source-of-truth] What each tab holds (design-docs/SETTINGS-MENU-MAP.md,
// "Structure"), keyed by every tab so none can be left without a body: its own
// segments, then the controls `PLACE` puts in it. Every body takes the
// controls, so `PLACE` naming any tab is a placement the bar renders.
interface TabBody {
  readonly direction: ContainerNode["direction"];
  readonly segments: readonly string[];
}
const TAB_CONTENT: Readonly<Record<TabName, TabBody>> = {
  session: { direction: "vertical", segments: [TOOLBAR_SEG, COMMANDS_SEG] },
  look: { direction: "horizontal", segments: [] },
  layout: { direction: "horizontal", segments: [PRESET_SAVE, EDIT_SEG] },
  config: { direction: "horizontal", segments: [] },
  tools: {
    direction: "vertical",
    segments: [DOCTOR_SEG, ...CHECKS.map((c) => doctorRowSeg(c.name))],
  },
};
const tabBody = (tab: TabName): ContainerNode => ({
  kind: "container",
  direction: TAB_CONTENT[tab].direction,
  children: [
    ...TAB_CONTENT[tab].segments.map(
      (name): LayoutNode => ({ kind: "segment", name }),
    ),
    ...controlsAt(tab),
  ],
});

// [LAW:one-type-per-behavior] The lowering, THE one every disclosure takes
// (`disclosureNode`, as lowerGroup): the anchor leaf becomes the toggle with
// the menu's body hung on it, wherever it sits, so the author's chosen
// position is the menu's position with nothing else moved. The door opens
// ABOVE: its body's rows stack over the whole bar, which renders as it does
// with the menu closed (brandon-menu-ia-q30.4oj). Each tab is a disclosure
// INSIDE that body — nesting is structure, not a second gate: a tab left open
// yesterday cannot render beside a closed menu today because it hangs on a
// trigger the closed menu does not render. The walk colours the body on the
// door's band and a tab's body on the band the tab opens, one depth
// further (candybar-render-ai7.9).
function expandAnchor(node: AnchoredRoot | LayoutNode): LayoutNode {
  if (node.kind === "segment") {
    return isSettingsAnchor(node.name)
      ? disclosureNode(node.name, SETTINGS_REF, DOOR_BODY, "above")
      : node;
  }
  return expandContainer(node);
}

// Two lines stacked over the bar, then the open tab's body. The first line
// holds what the menu is FOR — switching arrangement — and, beside it, the save
// cell whenever it has something to do. The second is the tab strip.
function doorBody(): ContainerNode {
  return {
    kind: "container",
    direction: "vertical",
    children: [
      {
        kind: "container",
        direction: "horizontal",
        children: [
          { kind: "segment", name: BACK_SEG },
          ...controlsAt("door"),
          { kind: "segment", name: SAVE_SEG },
        ],
      },
      {
        kind: "container",
        direction: "horizontal",
        children: TABS.map(({ member }) =>
          disclosureNode(
            tabSeg(member),
            tabRef(member),
            tabBody(member),
            "drop",
          ),
        ),
      },
    ],
  };
}

// The door's body is one value: the anchor hangs it and the fold reads its keys
// off it, so the two cannot describe different bodies.
const DOOR_BODY = doorBody();

// [LAW:one-source-of-truth] The door's click returns everything its body holds
// to how a fresh session finds it — each disclosure inside it, at any depth,
// written back to its state variable's default (the first tab, every picker
// closed) — so the menu never reopens onto panels left open from an earlier
// visit. The keys are read off the body itself, so a disclosure added to the
// menu later is folded with no list to keep. One action per key, fired beside
// the door's toggle in the same click.
function doorFolds(artifacts: MenuArtifacts): string[] {
  const keys = new Map<string, string>();
  for (const node of walkNodes(DOOR_BODY)) {
    if (node.kind === "segment" && node.opens !== undefined) {
      keys.set(node.opens.ref.key, node.opens.ref.variable);
    }
  }
  return [...keys].map(([key, variable]) => {
    const decl = artifacts.variables[variable];
    if (decl?.kind !== "state" || decl.default === undefined) {
      throw new Error(
        `settings menu: the door folds "${key}", but "${variable}" is not a state variable the menu declares with a default`,
      );
    }
    const name = `${SETTINGS_ANCHOR}.fold.${ident(key)}`;
    artifacts.actions[name] = { set: key, to: decl.default };
    return name;
  });
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
      [DOCTOR_RUN_ACTION]: { doctor: "run" },
      // [LAW:composability] Entering or leaving edit mode is a trip OUT of the
      // menu: edit mode works on the bar, with its own `✓ done` row above it,
      // so the menu closes and leaves the bar to it. The edit control is
      // therefore the toggle and the close fired as one click, composed from
      // two ordinary actions — the close is a literal write to the key the
      // door's own cycle writes, so each carries the gate it always carried.
      [SETTINGS_CLOSE]: { set: SETTINGS_REF.key, to: DISCLOSURE_CLOSED },
      [EDIT_SEG]: { do: [...EDIT_SWITCH, SETTINGS_CLOSE] },
      ...TOOLBAR.actions,
      ...COMMANDS.actions,
      [SAVE_SEG]: { save: true },
      [UNDO_ACTION]: { undo: true },
      // [LAW:composability] Going back can reopen a view a confirm sits in, so
      // it disarms every confirm as the door does: a confirm is only ever
      // clicked in the view its own arming click was made in.
      [BACK_STEP]: { back: true },
      [BACK_ACTION]: { do: [BACK_STEP, ...DOOR_DISARMS] },
      [REDO_ACTION]: { redo: true },
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
      // names what it opens, `✖` names what the click does.
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
      [BACK_SEG]: BACK_CELL,
      [SAVE_SEG]: SAVE_CELL,
      [PRESET_SAVE]: {
        template: `{{ action "${PRESET_SAVE}" "+ preset" }}`,
      },
      [DOCTOR_SEG]: {
        template: `{{ action "${DOCTOR_RUN_ACTION}" "🩺 doctor" }}`,
      },
      [EDIT_SEG]: {
        template: `{{ action "${EDIT_SEG}" "✎ arrange" "✎ done" }}`,
      },
    },
  };
  artifacts.variables[BACK_COUNT] = {
    kind: "input",
    path: "navigation.back",
    type: "number",
    default: 0,
  };
  // The counts the daemon publishes every render, one per save-cell part.
  for (const p of SAVE_PARTS) {
    artifacts.variables[p.count] = {
      kind: "input",
      path: p.path,
      type: "number",
      default: 0,
    };
  }
  // The open tab wears its state colour AND leads with the open-disclosure
  // glyph, so the strip still says which tab is open at colour depth `none`.
  // [LAW:composability] A tab click is its cycle and the disarm of every
  // confirm a tab holds, as one `do` (the door's shape): the tab is the click's
  // face, and switching tabs drops a half-made confirm it took out of view.
  artifacts.variables[TAB_KEY] = disclosureStateVar(TAB_KEY, FIRST_TAB);
  for (const { member, label } of TABS) {
    artifacts.actions[tabToggle(member)] = disclosureCycleAction(
      TAB_KEY,
      member,
    );
    artifacts.actions[tabSeg(member)] = {
      do: [tabToggle(member), ...TAB_DISARMS],
    };
    artifacts.segments[tabSeg(member)] = {
      template: disclosureTrigger(
        tabSeg(member),
        label,
        `${DISCLOSURE_GLYPH_OPEN} ${label}`,
      ),
    };
  }
  Object.assign(artifacts.variables, COMMANDS.variables, RESET_ALL.variables);
  declareSettingControls(artifacts);
  declareDoctorRows(artifacts);
  // Last, so every disclosure the body holds has declared its state.
  artifacts.actions[SETTINGS_ANCHOR] = {
    do: [DOOR_TOGGLE, ...DOOR_DISARMS, ...doorFolds(artifacts)],
  };
  return artifacts;
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

// Every control's artifacts: the actions the generator minted for it, the ↺
// that returns it to the bundled default — the session's pick and every layer
// of the config file a save can write (resetLayers,
// src/daemon/setting-drafts.ts), keyed by the config field a save writes so
// the two can never name different settings — and its segments. An inline
// control is one cell, the ↺ beside it; a ring is a trigger naming the value
// the bar renders with (the control's `effectiveVar`, whatever rung produced
// it), the toggle that opens its carousel on the shared accordion key, the ↺,
// and the carousel's own rows as segments of their own.
//
// A pick leaves its carousel open, re-centred on what it applied
// (brandon-theme-picker-bgw.etd): choosing a theme is trying several, so each
// try must not cost a reopen; ✕ closes. That holds for a preset pick too,
// whose click swaps the whole root — the menu survives it because every
// preset root references this one anchor and both open states are session
// keys, not tree positions.
function declareSettingControls(artifacts: MenuArtifacts): void {
  for (const c of CONTROLS) {
    Object.assign(artifacts.actions, c.control.actions);
    const reset = controlReset(c.name);
    artifacts.actions[reset] = { reset: c.configKey };
    const resetCell = `{{ action "${reset}" "↺" }}`;
    if (c.control.kind === "inline") {
      artifacts.segments[controlSeg(c.name)] = {
        template: `${c.control.template} ${resetCell}`,
      };
      continue;
    }
    const ref = controlRef(c.name);
    const toggle = menuActionName(ref.key, ref.member);
    artifacts.variables[ref.key] = disclosureStateVar(
      ref.key,
      DISCLOSURE_CLOSED,
    );
    artifacts.actions[toggle] = disclosureCycleAction(ref.key, ref.member);
    artifacts.segments[controlSeg(c.name)] = {
      template:
        `${c.label} {{ .${c.effectiveVar} }} ` +
        `${disclosureTrigger(toggle, DISCLOSURE_GLYPH_CLOSED, DISCLOSURE_GLYPH_OPEN)} ` +
        resetCell,
    };
    artifacts.segments[controlCarousel(c.name)] = {
      template: c.control.template,
    };
    c.beneath.forEach((row, i) => {
      artifacts.segments[controlBeneath(c.name, i)] = row;
    });
  }
  Object.assign(artifacts.actions, RESET_ALL.actions);
}

// [LAW:one-source-of-truth] Edit mode's state and switch, ensured rather than
// duplicated: this pass and synthesizeEditModeToggle both mint
// editModeArtifacts(), so whichever lands first is the only one. Ensuring it
// here is not an optional courtesy — the EDIT_SEG action above fires
// EDIT_SWITCH, and that pass is demand-driven off a scan of the segments a
// FILE declared, which cannot see a segment this pass mints later.
function ensureEditToggle(artifacts: MenuArtifacts): void {
  const { variables, actions } = editModeArtifacts();
  Object.assign(artifacts.variables, variables);
  Object.assign(artifacts.actions, actions);
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
