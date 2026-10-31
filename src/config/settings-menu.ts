// [LAW:one-source-of-truth] candybar-settings-ui-aok.1 — THE global settings
// menu: one disclosure that every rendered bar carries, whatever the config
// says — presets, edit mode, and the value controls are reachable from any
// root an author writes, not only from rows they inherited.
//
// [LAW:dataflow-not-control-flow] Placement is a POSITION, never a mode. The
// synthesis runs the same two total functions on every preset root, in the same
// order, every load: `withAnchor` yields a tree that CONTAINS the anchor — the
// author's own placement untouched, or the default position prepended — and
// `expandAnchor` replaces that one leaf with the lowered disclosure subtree
// and the frame-rate cell beside it.
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
// WHY THIS RUNS FROM validateRenderable, BEFORE synthesizeEditChrome — the two
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

import { sharedMenuStateKey } from "./menu-keys.js";
import { QUIET_TEXT } from "./quiet-text.js";
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
  DISCLOSURE_GLYPH_OPEN,
  DOOR_CLOSE_GLYPH,
  DOOR_CLOSE_ROLE,
  DOOR_GLYPH,
  disclosureCycleAction,
  disclosureNode,
  disclosureStateVar,
  disclosureTerm,
  disclosureTriggerCall,
  templateLiteral,
} from "./disclosure.js";
import { CHECKS, GLYPH_MARKS, type GlyphMark } from "../doctor/checks.js";
import {
  doctorReportKeys,
  VERDICT_OK,
  VERDICT_UNRUN,
} from "../doctor/report.js";
import { EDIT_TOGGLE_ACTION, editModeArtifacts } from "./loader/edit-mode.js";
import { presetByName, presetNames, presetRoot } from "./presets.js";
import { quickActions } from "./quick-actions.js";
import { commandTray } from "./command-tray.js";
import { autocompactControl } from "./autocompact-control.js";
import { formatTokenCount } from "./format-token-count.js";
import { confirmStep } from "./confirm-step.js";
import { SETTINGS_NS } from "./loader/reserved-namespace.js";
import {
  DIAGNOSTICS_VIEWING,
  SETTINGS_ANCHOR,
  SETTINGS_OPEN,
  SETTINGS_REF,
} from "./door.js";
import {
  SETTINGS,
  type SettingName,
  type SettingProjection,
} from "./setting-projections.js";
import { synthesisInputs } from "./synthesis-inputs.js";
import {
  PLACE,
  SUBMENUS,
  SUBMENU_NAMES,
  TABS,
  isSubmenu,
  within,
  type Place,
  type PreviewName,
  type SubmenuName,
  type TabName,
} from "./menu-places.js";
import { BOOLEAN_TRUE } from "../themes/policy.js";
import { settingControlDomain } from "./loader/globals.js";
import { settingControl, type Affordance } from "./setting-control.js";
import { declareHelp, type HelpArtifacts } from "./help.js";
import {
  drawingVar,
  LANE_NAMES,
  LANES,
  laneFeedVar,
  MOVING_FPS,
  type Drawing,
  type Lane,
} from "./lanes.js";
import { LANE_HELP } from "../help-text.js";

// The door lives in src/config/door.ts, downhill of edit mode, which sits
// inside it.
export { SETTINGS_ANCHOR, SETTINGS_OPEN } from "./door.js";

// The body's content segments.
const EDIT_SEG = `${SETTINGS_NS}edit`;
const TOOLBAR_SEG = `${SETTINGS_NS}toolbar`;
const TOOLBAR = quickActions(SETTINGS_NS);
const COMMANDS_SEG = `${SETTINGS_NS}commands`;
const COMMANDS = commandTray(`${COMMANDS_SEG}.`);
const AUTOCOMPACT_SEG = `${SETTINGS_NS}autocompact`;
const AUTOCOMPACT = autocompactControl(`${AUTOCOMPACT_SEG}.`, formatTokenCount);

// A reference to one of the menu's segments.
const seg = (name: string): LayoutNode => ({ kind: "segment", name });

// ─── The tabs (brandon-menu-tabs-wnu.qqz) ───────────────────────────────────
//
// [LAW:one-type-per-behavior] The door's second line is five tabs, one open at
// a time, its body dropped below the strip. A tab strip is an accordion: every
// tab is a disclosure trigger on ONE key, which holds the open tab's name, so
// opening one closes the rest and the open one wears its state colour like any
// open trigger. The key starts closed, and closing the door returns it there, as
// it returns everything inside the door (src/config/disclosure-nest.ts), so the
// menu always opens at its top level and a tab's body appears only when clicked.
const TAB_KEY = `${SETTINGS_NS}tab`;
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

// ─── Presets the user makes (brandon-save-undo-bwi.o6u) ─────────────────────
const PRESET_SAVE = `${SETTINGS_NS}preset.save`;
const PRESET_DELETE = `${SETTINGS_NS}preset.delete`;
// A default emoji (Emoji_Presentation), so rich-js measures it the two cells a
// terminal draws: the wastebasket U+1F5D1 is text-default, measured one cell,
// and its VS16 form is honoured unevenly (kgr; test/glyph-width.test.ts).
export const PRESET_DELETE_GLYPH = "🚮";

// [LAW:one-source-of-truth] A control's names, derived from its setting's
// name — the segment that shows it, the action it writes through, and the
// action its ↺ resets — so a control can never name a segment whose action
// writes a different setting.
const controlSeg = (name: string): string => `${SETTINGS_NS}${name}`;
const controlApply = (name: string): string => `${SETTINGS_NS}apply.${name}`;
const controlReset = (name: string): string => `${SETTINGS_NS}reset.${name}`;

// ─── A theme's default look (candybar-theme-colours-6fq5.ix8) ──────────────
//
// `⤓ default for <theme>` in the theme's ⚙ gear: save the shade, variation
// and style the bar wears — the gear's own settings — as the active theme's
// default. The cell shows exactly while saving would change something — a fact the daemon publishes every
// render (RenderPayload.themeDefault, src/daemon/setting-drafts.ts), never one
// a template computes — and so is the theme it names: the one the click
// writes, not `theme.effective`, which edit mode's staged palette can move.
const THEME_DEFAULT_SEG = `${SETTINGS_NS}themeDefault.save`;
const THEME_DEFAULT_DIFFERS = `${SETTINGS_NS}themeDefault.differs`;
const THEME_DEFAULT_THEME = `${SETTINGS_NS}themeDefault.theme`;
// The theme's name carries its swatch, as every theme name the bar shows does
// (brandon-theme-swatch-8v9r), drawn through the theme control's own action.
const THEME_DEFAULT_CELL: SegmentDecl = {
  when: `{{ .${THEME_DEFAULT_DIFFERS} }}`,
  template:
    `{{ action "${THEME_DEFAULT_SEG}" (printf "⤓ default for %s" .${THEME_DEFAULT_THEME}) }} ` +
    `{{ swatch "${controlApply("theme")}" .${THEME_DEFAULT_THEME} }}`,
};

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
const BACK_CELL: SegmentDecl = {
  template:
    `{{ if gt .${BACK_COUNT} 0 }}{{ action "${BACK_ACTION}" "${BACK_GLYPH}" }}` +
    `{{ else }}{{ fg (${QUIET_TEXT}) "${BACK_GLYPH}" }}{{ end }}`,
};
const REDO_ACTION = `${SETTINGS_NS}redo`;

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
const doctorMarkAction = (check: string, mark: GlyphMark): string =>
  `${DOCTOR_SEG}.mark.${check}.${mark}`;
const doctorRowSeg = (check: string): string => `${DOCTOR_SEG}.${check}`;
// What each mark says, in the words a user looks with.
const MARK_GLYPH: Readonly<Record<GlyphMark, string>> = {
  drawn: "[✓ shapes]",
  boxes: "[✗ boxes]",
};

// [LAW:one-source-of-truth] One accordion key for every picker in the menu:
// one key holds one open member, so opening a theme picker closes the style
// picker. The settings menu is a narrow panel — two open drop-downs would
// overflow it — and this is the same shared-key mechanism group sugar uses,
// selected by a value, not a mode. Spelled as a shared `{{ menu }}` key, so a
// `{{ menu }}` an author gives the same shared key joins this accordion.
const PICKER_KEY = sharedMenuStateKey(`${SETTINGS_NS}pickers`);

// ─── Submenus (brandon-theme-swatch-8v9r, brandon-menus-sjhy.5zy) ─────────
//
// A submenu (SUBMENUS, menu-places.ts) is a member of the accordion the
// control it is laid beside sits on, so opening it closes the lists beside it
// and the reverse — one panel under the row at a time — and the lists of the
// controls inside it share an accordion of their own: a key nested under a
// body holding it would close the body that shows it.
const submenuSeg = (name: SubmenuName): string => `${SETTINGS_NS}${name}`;
const submenuToggle = (name: SubmenuName): string =>
  `${submenuSeg(name)}.toggle`;
// The accordion every list and submenu laid in `place` joins.
const accordionOf = (place: Place): string =>
  isSubmenu(place)
    ? sharedMenuStateKey(`${SETTINGS_NS}${place}Pickers`)
    : PICKER_KEY;
// A submenu is a member of the accordion the control it is laid beside sits on.
const submenuRef = (name: SubmenuName): DisclosureRef => {
  const key = accordionOf(PLACE[SUBMENUS[name].beside]);
  return { variable: key, key, member: name };
};

// [LAW:types-are-the-program] What each preview a setting's row names draws
// under its list of options — each a row, open while the list is. The list
// names the options; these show what the current one does to the bar.
const PREVIEWS: Readonly<Record<PreviewName, SegmentDecl>> = {
  // `{{ layoutPreview }}` draws every row of the arrangement, one block per
  // segment, named, each block in the tint the bar's variation and shade deal
  // it — so it shows what a preset, a variation or a shade changes.
  layout: { template: "{{ layoutPreview }}" },
  // A style chooses how the bar's palette is adapted, and `{{ themePreview }}`
  // samples exactly the palette the bar is drawn in. (The theme picker carries
  // its own demo of the theme it has selected.)
  palette: { template: "{{ themePreview }}" },
  // While the preset ring is on a preset the user made
  // (brandon-save-undo-bwi.o6u), the click that deletes it; `+ preset` in the
  // 📐 layout tab makes one.
  presetDelete: {
    when: "{{ not .preset.bundled }}",
    template: `{{ action "${PRESET_DELETE}" (printf "${PRESET_DELETE_GLYPH} delete %s" .${SETTINGS.preset.effectiveVar}) }}`,
  },
};

// Row `row` of the body a picker opens: its list's rows, then the rows
// beneath them.
const controlRow = (name: string, row: number): string =>
  `${SETTINGS_NS}list.${name}.${row}`;
// Whether the setting's reset would change anything (RenderPayload.resettable,
// brandon-menu-ia-q30.nk8): the one fact its `↺`, the `•` on every trigger
// opening a place it is under, and `⟲` read.
const controlResettable = (name: string): string =>
  `${SETTINGS_NS}resettable.${name}`;
// What a marked trigger carries after its label.
const DRIFT_MARK = " •";
// A boolean `or` over the controls' resettable flags, each only while its
// control is offered to the session — `false` over none, so a tab holding no
// control is never marked, and a mark never points at a control not drawn.
const anyResettable = (
  controls: ReadonlyArray<Pick<MenuControl, "name" | "shown">>,
): string =>
  controls.length === 0
    ? "false"
    : `(or ${controls.map((c) => `(and (${c.shown}) .${controlResettable(c.name)})`).join(" ")})`;

// ─── The animation lanes' toggles (brandon-menus-sjhy.amf) ────────────────
//
// Brandon: "Each toggle should explain what it does. Each toggle also needs to
// do all of the work needed to turn its lane on, not just part of it." A
// lane's switch only lets its subscriber's frames through; the subscriber
// itself — a mod, Claude Code under cc-attach, a tmux pane — is started by
// the daemon when the switch the session renders by moves
// (src/daemon/lane-setup.ts), so the toggle is a plain setting. Beside it, a
// `(?)` says what the lane is and what turning it on does, from the help
// corpus `--help` prints.
const laneSettings = LANE_NAMES.map(
  (lane) => [LANES[lane].switch.setting, lane] as const,
);

// The `(?)` laid after a control, and the artifacts it declares.
const HELP_ARTIFACTS: HelpArtifacts = {
  variables: {},
  actions: {},
  segments: {},
};
const HELP: Partial<Record<SettingName, LayoutNode>> = Object.fromEntries(
  laneSettings.map(([setting, lane]) => {
    const name = `${SETTINGS_NS}help.${setting}`;
    return [setting, declareHelp(name, LANE_HELP[lane], [], HELP_ARTIFACTS)];
  }),
);

// One control of the menu: its setting's row of SETTINGS and what the
// generator made of that setting's declared domain.
interface MenuControl extends SettingProjection {
  readonly name: SettingName;
  readonly control: Affordance;
  readonly beneath: readonly SegmentDecl[];
  // What the menu lays right after it: its help, and the submenus beside it.
  readonly help: readonly LayoutNode[];
  readonly submenus: readonly SubmenuName[];
}

// [LAW:nothing-unseen] While a lane is on, its toggle says what its frames are
// doing: with nobody following the session on that lane, that none is; else a
// spinner turning a glyph every frame the feed draws at its moving rate, then
// the frames that went out to the lane in the last second, and that the pane is judged
// off screen when it is (it is then drawn at one a second). The spinner is the
// motion: it makes every frame new, so the number is the rate the daemon can
// push this lane while something moves, not whether an effect animates. The
// number is what left the daemon; whether those frames arrive is the spinner,
// drawn by the follower: smooth when they do, stepping when a follower falls
// behind (its socket keeps only the newest frame) or the bar is polled. The
// bundled effects move about one visible step a second, so a pushed bar and a
// polled one look alike without it.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const laneReadout = (lane: Lane): string => {
  const feed = (field: "subscribers" | "fps" | "shown") =>
    `.${laneFeedVar(lane, field)}`;
  const spinner = SPINNER.map((glyph) => `${1 / MOVING_FPS} "${glyph}"`).join(
    " ",
  );
  return (
    // [LAW:dataflow-not-control-flow] One test for every switch, a flag's or
    // the renderer's: the setting's value against the one that turns the lane
    // on, each spelled as a template literal of its own type.
    `{{ if eq .${SETTINGS[LANES[lane].switch.setting].effectiveVar} ${JSON.stringify(LANES[lane].switch.on)} }} ` +
    `{{ if ${feed("subscribers")} }}{{ realtimeFrames ${spinner} }} {{ ${feed("fps")} }} fps` +
    `{{ if not ${feed("shown")} }} · off screen{{ end }}` +
    `{{ else }}no subscriber{{ end }}{{ end }}`
  );
};
// [LAW:nothing-unseen] Every bar says how it is redrawn, in the cell beside the
// door. On a frame the feed drew: the most frames a second the feed draws it
// at — the moving rate while its pane is on a screen, one a second while it
// is not — written `≤`, since the feed draws a bar only as often as it
// changes, and a still bar on a screen is drawn once a second. On a request's
// answer: that Claude Code polls it. A polled bar has no rate to show, since
// its redraws are Claude Code's, and the requests that carry them cannot tell
// its timer from its event redraws or a daemon stall.
// [LAW:dataflow-not-control-flow] The one branch is Drawing's own
// discriminator. Both forms are padded to the wider of `polled` and the
// fastest ceiling, MOVING_FPS, so a bar starting, stopping or losing its lane
// moves no cell after it.
// [LAW:single-enforcer] Every error and warning a draw owes its reader is one
// indicator, a second click region in the door's own cell, so it sits beside
// the door wherever an author put it and no layout can leave it out. It reads
// the draw's `diagnostics` projection, the same list the viewer pages
// (src/render/diagnostics.ts); its click opens the viewer on the first
// message, by that message's key. Nothing to show is an empty label, which draws nothing.
const DIAGNOSTICS_INDICATOR =
  `{{ if .diagnostics.label }} ` +
  `{{ bg .diagnostics.bg (fg .diagnostics.fg (action "${DIAGNOSTICS_VIEWING}" .diagnostics.label .diagnostics.open)) }}` +
  `{{ end }}`;

const FPS_SEG = `${SETTINGS_NS}fps`;
export const POLLED = "polled";
const AT_MOST = "≤";
const FPS_UNIT = " fps";
const RATE_WIDTH = Math.max(
  POLLED.length,
  AT_MOST.length + String(MOVING_FPS).length + FPS_UNIT.length,
);
const FRAME_RATE =
  `{{ if eq .${drawingVar("by")} "${"feed" satisfies Drawing["by"]}" }}` +
  `{{ printf "%${RATE_WIDTH - FPS_UNIT.length}s" (printf "${AT_MOST}%d" (int .${drawingVar("fps")})) }}${FPS_UNIT}` +
  `{{ else }}${POLLED.padStart(RATE_WIDTH)}{{ end }}`;

// What a control shows after itself: a lane's toggle its readout.
const TRAIL: Partial<Record<SettingName, string>> = Object.fromEntries(
  laneSettings.map(([setting, lane]) => [setting, laneReadout(lane)]),
);

// [LAW:one-source-of-truth] Every setting the menu offers, generated
// (brandon-settings-coverage-g4p.zoj): one control per row of SETTINGS, its
// shape — a toggle, a stepper, a picker — decided by the domain the field's
// row declares beside its spec (`settingControlDomain`), through the same
// generator configure mode uses for a placement's settings. Every apply
// action is a session `set`: a draft until the save cell commits it. A field
// no control shape fits is a `text` row, which is no setting at all.
// The submenus laid right after a setting's control.
const submenusBeside = (name: SettingName): SubmenuName[] =>
  SUBMENU_NAMES.filter((s) => SUBMENUS[s].beside === name);
const menuControl = (name: SettingName): MenuControl => {
  const row: SettingProjection = SETTINGS[name];
  const place = PLACE[name];
  return {
    ...row,
    name,
    place,
    control: settingControl(
      {
        label: row.label,
        domain: settingControlDomain(row.configKey),
      },
      row.sessionKey,
      row.effectiveVar,
      controlApply(name),
      accordionOf(place),
    ),
    beneath: row.previews.map((preview) => PREVIEWS[preview]),
    help: [HELP[name]].filter((h) => h !== undefined),
    submenus: submenusBeside(name),
  };
};
const CONTROLS: readonly MenuControl[] = (
  Object.keys(SETTINGS) as SettingName[]
).map(menuControl);

const controlsIn = (place: Place): readonly MenuControl[] =>
  CONTROLS.filter((c) => c.place === place);
// What a place holds, the controls inside its submenus included.
const controlsUnder = (place: Place): readonly MenuControl[] =>
  CONTROLS.filter((c) => within(c.place, place));
// [LAW:one-source-of-truth] A trigger that opens a place — a tab, a submenu —
// is marked `•` while a control inside it would change on reset
// (brandon-menu-ia-q30.nk8), open or closed, so drift is findable without
// opening each one. The mark rides inside the trigger's link. The door itself
// is unmarked: `⟲` on its first line says the same.
const markedDisplay =
  (place: Place) =>
  (text: string): string =>
    `(print ${templateLiteral(text)} (ternary ${templateLiteral(DRIFT_MARK)} "" ${anyResettable(
      controlsUnder(place),
    )}))`;
// The controls in `place`, each followed by the submenus laid beside it, whose
// bodies are laid the same way.
// [LAW:single-enforcer] Everything laid at a control — the control, its `(?)`,
// its submenus — is offered where the control is, by the control's one gate.
const controlsAt = (place: Place): LayoutNode[] =>
  controlsIn(place).flatMap((c) =>
    [
      controlNode(c),
      ...c.help,
      ...c.submenus.map((s) =>
        disclosureNode(submenuSeg(s), submenuRef(s), placeBody(s), "drop"),
      ),
    ].map((node): LayoutNode => ({ ...node, when: `{{ ${c.shown} }}` })),
  );

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

// [LAW:single-enforcer] `⟲` resets the controls the session it is drawn in is
// offered, by the same gate each control is drawn by and the `•` counts it by:
// a control offered only to some sessions (the renderer, inside tmux) is reset
// where it is drawn, and never by a reset-all clicked where it is not, since
// the sessions share the setting.
const RESET_ALL = confirmStep(
  RESET_ALL_SEG,
  { arm: "⟲", confirm: "⟲ reset all?" },
  CONTROLS.map((c) => ({ action: controlReset(c.name), when: c.shown })),
);

// ─── The save cell ──────────────────────────────────────────────────────────
//
// [LAW:one-source-of-truth] `💾 save 3 ↶ ↷ ⟲` — one cell beside the preset,
// each part present exactly while it has something to do, read from what the
// daemon publishes every render: save while there are drafts, undo and redo
// while their stack has a step, `⟲` while any control's reset would change
// something (its `↺` shows) or while it is armed, so its confirm is never
// hidden armed. So a click on any part always does something.
interface SavePart {
  readonly body: string;
  readonly shown: string;
}
// The payload paths of the counts the save cell reads; each is read through
// the input variable `saveCountVar(path)`.
const SAVE_COUNTS = ["unsaved", "history.undo", "history.redo"] as const;
type SaveCount = (typeof SAVE_COUNTS)[number];
const saveCountVar = (count: SaveCount): string => `${SETTINGS_NS}${count}`;
// Exported for edit mode's `✓ save`, which reads the same count (see SAVE_SEG).
export const UNSAVED_VAR = saveCountVar("unsaved");
const counted = (count: SaveCount, body: string): SavePart => ({
  body,
  shown: `(gt .${saveCountVar(count)} 0)`,
});
const SAVE_PARTS: readonly SavePart[] = [
  counted(
    "unsaved",
    `{{ action "${SAVE_SEG}" (printf "💾 save %d" .${UNSAVED_VAR}) }}`,
  ),
  counted("history.undo", `{{ action "${UNDO_ACTION}" "↶" }}`),
  counted("history.redo", `{{ action "${REDO_ACTION}" "↷" }}`),
  {
    body: RESET_ALL.template,
    shown: `(or ${anyResettable(CONTROLS)} ${RESET_ALL.armed})`,
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

// [LAW:dataflow-not-control-flow] Every control takes one place in the tree,
// decided by what the generator made of it: an inline control is its own
// cell; a picker hangs its list of options, and the rows beneath it, on the
// control through the one disclosure lowering, dropped below the row it sits
// in. Every picker's list joins one accordion (PICKER_KEY).
function controlNode(c: MenuControl): LayoutNode {
  const self = controlSeg(c.name);
  if (c.control.kind === "inline") return seg(self);
  return disclosureNode(
    self,
    c.control.list.ref,
    {
      kind: "container",
      direction: "vertical",
      children: [...c.control.list.rows, ...c.beneath].map((_, row) =>
        seg(controlRow(c.name, row)),
      ),
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
  const anchorRef: LayoutNode = seg(SETTINGS_ANCHOR);
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
  if (node.kind === "segment") {
    return {
      kind: "container",
      direction: "horizontal",
      children: [anchorRef, node],
    };
  }
  if (node.when === undefined) {
    return { ...node, children: [anchorRef, ...node.children] };
  }
  // [LAW:one-source-of-truth] A gated row is led from outside its gate: it
  // stays the row, now led by the door, and only its gate moves in, onto a
  // container around its cells. A row nested in a row places nothing, so
  // whatever makes it a row (its distribution) stays on the row its cells are
  // laid on, as an ungated row's places the door beside its cells.
  const { when, children, ...row } = node;
  return {
    ...row,
    children: [
      anchorRef,
      { kind: "container", direction: row.direction, when, children },
    ],
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

// [LAW:one-source-of-truth] What each place holds (design-docs/SETTINGS-MENU-MAP.md,
// "Structure") — the door's first line, each tab, each submenu — keyed by every
// place so none can be left without a body: its own segments, then the
// controls `PLACE` puts in it, then what follows them. Every body takes the
// controls, so `PLACE` naming any place is a placement the bar renders. A
// body's own cell whose width changes — one that comes and goes, or relabels
// itself — sits `after` the controls, so it moves none of them; a control's
// own width (its value, its `↺`, a submenu's `•`) moves what follows it.
interface PlaceBody {
  readonly direction: ContainerNode["direction"];
  readonly content: readonly LayoutNode[];
  readonly after: readonly LayoutNode[];
}
const PLACE_BODY: Readonly<Record<Place, PlaceBody>> = {
  // `◁ back`, the controls one click from the door — theme, preset — then
  // arranging the bar, then the save cell whenever it has something to do.
  door: {
    direction: "horizontal",
    content: [seg(BACK_SEG)],
    after: [seg(EDIT_SEG), seg(SAVE_SEG)],
  },
  // The quick actions, then the commands typed into Claude Code beside the
  // auto-compact window they would summarize at.
  session: {
    direction: "vertical",
    content: [
      seg(TOOLBAR_SEG),
      {
        kind: "container",
        direction: "horizontal",
        children: [seg(COMMANDS_SEG), seg(AUTOCOMPACT_SEG)],
      },
    ],
    after: [],
  },
  look: { direction: "horizontal", content: [], after: [] },
  layout: { direction: "horizontal", content: [seg(PRESET_SAVE)], after: [] },
  config: { direction: "horizontal", content: [], after: [] },
  tools: {
    direction: "vertical",
    content: [seg(DOCTOR_SEG), ...CHECKS.map((c) => seg(doctorRowSeg(c.name)))],
    after: [],
  },
  // The settings that adapt the theme, then — while the look they make
  // differs from the theme's own default — the cell that saves it as that
  // default.
  gear: {
    direction: "horizontal",
    content: [],
    after: [seg(THEME_DEFAULT_SEG)],
  },
  toggles: { direction: "horizontal", content: [], after: [] },
};
function placeBody(place: Place): ContainerNode {
  const { direction, content, after } = PLACE_BODY[place];
  return {
    kind: "container",
    direction,
    children: [...content, ...controlsAt(place), ...after],
  };
}

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
//
// [LAW:single-enforcer] The anchor is the one position every bar is
// guaranteed, so what every bar carries hangs on it: the door and, beside it,
// how the bar is redrawn (FRAME_RATE). One node, so no preset or authored root
// has to remember the rate; a plain horizontal one, so the two take two places
// of the row and differ in shade as any two cells side by side do.
function expandAnchor(node: AnchoredRoot | LayoutNode): LayoutNode {
  if (node.kind === "segment") {
    return isSettingsAnchor(node.name)
      ? {
          kind: "container",
          direction: "horizontal",
          children: [
            disclosureNode(node.name, SETTINGS_REF, DOOR_BODY, "above"),
            seg(FPS_SEG),
          ],
        }
      : node;
  }
  return expandContainer(node);
}

// Two lines stacked over the bar, then the open tab's body. The first line
// holds what the menu is most often opened for — the theme, the preset,
// arranging the bar — and the save cell (PLACE_BODY.door). The second is the
// tab strip.
function doorBody(): ContainerNode {
  return {
    kind: "container",
    direction: "vertical",
    children: [
      placeBody("door"),
      {
        kind: "container",
        direction: "horizontal",
        children: TABS.map(({ member }) =>
          disclosureNode(
            tabSeg(member),
            tabRef(member),
            placeBody(member),
            "drop",
          ),
        ),
      },
    ],
  };
}

const DOOR_BODY = doorBody();

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
      [DIAGNOSTICS_VIEWING]: {
        kind: "state",
        key: DIAGNOSTICS_VIEWING,
        default: "0",
      },
    },
    actions: {
      [DOOR_TOGGLE]: disclosureCycleAction(SETTINGS_ANCHOR, SETTINGS_OPEN),
      [DIAGNOSTICS_VIEWING]: { set: DIAGNOSTICS_VIEWING, int: true },
      [SETTINGS_ANCHOR]: { do: [DOOR_TOGGLE, ...DOOR_DISARMS] },
      [DOCTOR_RUN_ACTION]: { doctor: "run" },
      ...TOOLBAR.actions,
      ...COMMANDS.actions,
      ...AUTOCOMPACT.actions,
      [SAVE_SEG]: { save: true },
      [UNDO_ACTION]: { undo: true },
      // [LAW:composability] Going back can reopen a view a confirm sits in, so
      // it disarms every confirm as the door does: a confirm is only ever
      // clicked in the view its own arming click was made in.
      [BACK_STEP]: { back: true },
      [BACK_ACTION]: { do: [BACK_STEP, ...DOOR_DISARMS] },
      [REDO_ACTION]: { redo: true },
      [PRESET_SAVE]: { preset: "save" },
      [THEME_DEFAULT_SEG]: { themeDefault: "save" },
      [PRESET_DELETE]: {
        preset: "delete",
        name: `{{ .${SETTINGS.preset.effectiveVar} }}`,
      },
    },
    segments: {
      // [LAW:one-source-of-truth] ONE symbol per state, unlike the labelled toggles
      // below, which are a word plus the ▸/▾ that gates it. The door has no
      // label to gate: it is a glyph, so a second glyph beside it would be the
      // only thing on the bar that spells its state twice. The door's glyph
      // names what it opens, `✖` names what the click does.
      //
      // Two displays through the same `[closed, member]` cycle every other
      // disclosure binds: the shape did not change, only the values. Open,
      // the ✖ wears a red the theme names for `DOOR_CLOSE_ROLE`, as the theme
      // gives it (`roleTextOn`): the theme's text-red where that reads on the
      // pressed state, otherwise the role's own red or the nearest rung of its
      // ladder out toward the pole the pressed state stands farther from that
      // does, and where none does, the named red standing farthest off. It
      // never slides lightness: a slid red stops reading as red, and the ✖
      // must be red on every theme. `keptOn` only stops the terminal's
      // rounding from costing it the contrast it has. Closed, the author's
      // glyph keeps the cell's own text.
      [SETTINGS_ANCHOR]: {
        template:
          `{{ $door := ${disclosureTriggerCall(SETTINGS_ANCHOR, templateLiteral(doorGlyph), templateLiteral(DOOR_CLOSE_GLYPH))} }}` +
          `{{ if ${disclosureTerm(SETTINGS_REF)} }}` +
          `{{ fg (keptOn (roleTextOn "${DOOR_CLOSE_ROLE}" (bgOf)) (bgOf)) $door }}` +
          `{{ else }}{{ $door }}{{ end }}` +
          DIAGNOSTICS_INDICATOR,
      },
      [FPS_SEG]: { template: FRAME_RATE },
      [TOOLBAR_SEG]: { template: TOOLBAR.template },
      [COMMANDS_SEG]: { template: COMMANDS.template, when: COMMANDS.when },
      [AUTOCOMPACT_SEG]: {
        template: AUTOCOMPACT.template,
        bg: AUTOCOMPACT.bg,
        when: AUTOCOMPACT.when,
      },
      [BACK_SEG]: BACK_CELL,
      [SAVE_SEG]: SAVE_CELL,
      [THEME_DEFAULT_SEG]: THEME_DEFAULT_CELL,
      [PRESET_SAVE]: {
        template: `{{ action "${PRESET_SAVE}" "+ preset" }}`,
      },
      [DOCTOR_SEG]: {
        template: `{{ action "${DOCTOR_RUN_ACTION}" "🩺 doctor" }}`,
      },
      [EDIT_SEG]: {
        // Entering or leaving edit mode is a click like every other in the
        // menu: the menu stays as it was, so `◁ back` and the tabs stay in
        // reach while the bar is arranged.
        template: `{{ action "${EDIT_TOGGLE_ACTION}" "✎ arrange" "✎ done" }}`,
      },
    },
  };
  artifacts.variables[THEME_DEFAULT_DIFFERS] = {
    kind: "input",
    path: "themeDefault.differs",
    type: "boolean",
    default: false,
  };
  artifacts.variables[THEME_DEFAULT_THEME] = {
    kind: "input",
    path: "themeDefault.theme",
    type: "string",
    default: "",
  };
  artifacts.variables[BACK_COUNT] = {
    kind: "input",
    path: "navigation.back",
    type: "number",
    default: 0,
  };
  // The counts the daemon publishes every render, read by the save cell.
  for (const count of SAVE_COUNTS) {
    artifacts.variables[saveCountVar(count)] = {
      kind: "input",
      path: count,
      type: "number",
      default: 0,
    };
  }
  // The open tab wears its state colour AND leads with the open-disclosure
  // glyph, so the strip still says which tab is open at colour depth `none`.
  // [LAW:composability] A tab click is its cycle and the disarm of every
  // confirm a tab holds, as one `do` (the door's shape): the tab is the click's
  // face, and switching tabs drops a half-made confirm it took out of view.
  artifacts.variables[TAB_KEY] = disclosureStateVar(TAB_KEY, DISCLOSURE_CLOSED);
  for (const { member, label } of TABS) {
    artifacts.actions[tabToggle(member)] = disclosureCycleAction(
      TAB_KEY,
      member,
    );
    artifacts.actions[tabSeg(member)] = {
      do: [tabToggle(member), ...TAB_DISARMS],
    };
    const display = markedDisplay(member);
    artifacts.segments[tabSeg(member)] = {
      template: `{{ ${disclosureTriggerCall(
        tabSeg(member),
        display(label),
        display(`${DISCLOSURE_GLYPH_OPEN} ${label}`),
      )} }}`,
    };
  }
  Object.assign(artifacts.variables, COMMANDS.variables, RESET_ALL.variables);
  declareSettingControls(artifacts);
  declareDoctorRows(artifacts);
  return artifacts;
}

// [LAW:one-source-of-truth] One report row per check, minted from the CHECKS
// list the doctor folds over, its keys from the SAME `doctorReportKeys` the
// doctor verbs write through. A row exists exactly when its check has run
// (`verdict` left its unrun default); it reads `✓ label`, or `✗ label — reason`
// with a `[fix]` bound to that check's own fix action when the verdict carried
// one. The `[fix]` is `{ doctor: "fix", check }` — the daemon re-probes the
// check at click time and refuses loudly if there is nothing left to fix. A
// verdict that shows glyphs to look at adds them, then a ✓ and a ✗ — each
// `{ doctor: "mark", check, mark }`, re-probed at click time the same way.
function declareDoctorRows(artifacts: MenuArtifacts): void {
  for (const c of CHECKS) {
    const keys = doctorReportKeys(c.name);
    const fix = doctorFixAction(c.name);
    for (const key of Object.values(keys)) {
      artifacts.variables[key] = { kind: "state", key, default: VERDICT_UNRUN };
    }
    artifacts.actions[fix] = { doctor: "fix", check: c.name };
    // Only a check that takes a mark gets the actions that make one.
    const marks = c.takesMark ? GLYPH_MARKS : [];
    for (const mark of marks) {
      artifacts.actions[doctorMarkAction(c.name, mark)] = {
        doctor: "mark",
        check: c.name,
        mark,
      };
    }
    const markCells = marks
      .map(
        (mark) =>
          ` {{ action "${doctorMarkAction(c.name, mark)}" "${MARK_GLYPH[mark]}" }}`,
      )
      .join("");
    artifacts.segments[doctorRowSeg(c.name)] = {
      when: `{{ ne .${keys.verdict} "${VERDICT_UNRUN}" }}`,
      template:
        `{{ if eq .${keys.verdict} "${VERDICT_OK}" }}✓ ${c.label}{{ if ne .${keys.reason} "" }} — {{ .${keys.reason} }}{{ end }}` +
        `{{ else }}✗ ${c.label} — {{ .${keys.reason} }}` +
        `{{ if eq .${keys.fixable} "${BOOLEAN_TRUE}" }} {{ action "${fix}" "[fix]" }}{{ end }}` +
        (markCells === ""
          ? ""
          : `{{ if ne .${keys.sighting} "" }} {{ .${keys.sighting} }}${markCells}{{ end }}`) +
        `{{ end }}`,
    };
  }
}

// Every control's artifacts: the actions the generator minted for it, the ↺
// that returns it to the bundled default — the session's pick and every layer
// of the config file a save can write (resetLayers,
// src/daemon/setting-drafts.ts), keyed by the config field a save writes so
// the two can never name different settings — and its segments. An inline
// control is one cell, the ↺ beside it; a picker is `◀ label ▶`, whose label
// opens its list on the shared accordion key, then the ↺; the rows beneath it
// are segments of their own.
//
// A pick leaves the list open (brandon-theme-picker-bgw.etd): choosing a theme
// is trying several, so each try must not cost a reopen; ✕ closes. That holds for a preset pick too,
// whose click swaps the whole root — the menu survives it because every
// preset root references this one anchor and both open states are session
// keys, not tree positions.
function declareSettingControls(artifacts: MenuArtifacts): void {
  for (const c of CONTROLS) {
    Object.assign(artifacts.actions, c.control.actions);
    const reset = controlReset(c.name);
    artifacts.actions[reset] = { reset: c.configKey };
    // The ↺ shows only while its reset would change something — a draft, or
    // a value the file holds at a layer the reset clears (brandon-menu-ia-q30.nk8).
    artifacts.variables[controlResettable(c.name)] = {
      kind: "input",
      path: `resettable.${c.name}`,
      type: "boolean",
      default: false,
    };
    const resetCell = `{{ if .${controlResettable(c.name)} }} {{ action "${reset}" "↺" }}{{ end }}`;
    Object.assign(artifacts.variables, c.control.variables);
    // Whom a control is offered to gates where it is laid (`controlsAt`); its
    // list hangs on it, so hiding it hides the list.
    artifacts.segments[controlSeg(c.name)] = {
      template: `${c.control.template}${TRAIL[c.name] ?? ""}${resetCell}`,
    };
    if (c.control.kind === "picker") {
      [
        ...c.control.list.rows.map((template): SegmentDecl => ({ template })),
        ...c.beneath,
      ].forEach((row, i) => {
        artifacts.segments[controlRow(c.name, i)] = row;
      });
    }
  }
  Object.assign(artifacts.actions, RESET_ALL.actions);
  Object.assign(artifacts.variables, HELP_ARTIFACTS.variables);
  Object.assign(artifacts.actions, HELP_ARTIFACTS.actions);
  Object.assign(artifacts.segments, HELP_ARTIFACTS.segments);
  // Each submenu's trigger: one static label, open or closed — the open
  // trigger wears its band's state colour, as every disclosure trigger does.
  for (const name of SUBMENU_NAMES) {
    const ref = submenuRef(name);
    artifacts.actions[submenuToggle(name)] = disclosureCycleAction(
      ref.key,
      ref.member,
    );
    artifacts.segments[submenuSeg(name)] = {
      template: `{{ action "${submenuToggle(name)}" ${markedDisplay(name)(SUBMENUS[name].trigger)} }}`,
    };
  }
}

// [LAW:one-source-of-truth] Edit mode's state and switch, ensured rather than
// duplicated: this pass and synthesizeEditModeToggle both mint
// editModeArtifacts(), so whichever lands first is the only one. Ensuring it
// here is not an optional courtesy — the EDIT_SEG segment above fires
// `edit.toggle`, and that pass is demand-driven off a scan of the segments a
// FILE declared, which cannot see a segment this pass mints later.
function ensureEditToggle(artifacts: MenuArtifacts): void {
  const { variables, actions } = editModeArtifacts();
  Object.assign(artifacts.variables, variables);
  Object.assign(artifacts.actions, actions);
}

// [LAW:single-enforcer] THE synthesis entry point, called once from
// validateRenderable after cross-ref/cycle checks pass and before edit chrome.
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
