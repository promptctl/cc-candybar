// [LAW:one-source-of-truth] THE global settings menu: one disclosure every
// rendered bar carries, whatever the config says.
// [LAW:dataflow-not-control-flow] Placement is a POSITION, never a mode.
// [LAW:one-type-per-behavior] Not a new concept — the disclosure primitive again.
// Runs from validateConfig (it needs the MERGED root) and before edit chrome, so
// the reserved `settings.` names never acquire a `-` and the menu is undeletable.

import type { ActionDecl } from "./action.js";
import {
  mapOpens,
  walkNodes,
  type DisclosureRef,
  type DslConfig,
  type LayoutNode,
  type PresetDecl,
  type SegmentDecl,
  type SegmentNode,
  type VariableDecl,
} from "./dsl-types.js";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSED,
  DISCLOSURE_GLYPH_OPEN,
  disclosureCycleAction,
  disclosureNode,
  disclosureStateVar,
  disclosureTrigger,
} from "./disclosure.js";
import { declareHelp } from "./help.js";
import { PERSIST_HELP } from "../help-text.js";
import { CHECKS } from "../doctor/checks.js";
import {
  doctorReportKeys,
  VERDICT_OK,
  VERDICT_UNRUN,
} from "../doctor/report.js";
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

// [LAW:one-source-of-truth] Reserved namespace; a user name under it is a load error.
export const SETTINGS_NS = "settings.";

// [LAW:one-source-of-truth] THE anchor: the segment name an author places, the
// toggle segment, the state variable, and the cycle action are one string.
export const SETTINGS_ANCHOR = `${SETTINGS_NS}menu`;

const SETTINGS_OPEN = EDIT_MODE_OPEN;

const EDIT_SEG = `${SETTINGS_NS}edit`;

// [LAW:one-source-of-truth] ONE control per setting, bound to one DUAL action;
// `charset`/`colorCompatibility` are absent — no session half to choose.
const PERSIST_SEG = `${SETTINGS_NS}persist`;
const CONFIG_SEG = `${SETTINGS_NS}config`;

const PERSIST_KEY = PERSIST_SEG;

// [LAW:one-source-of-truth] Refs, not gate strings, so a toggle and its `when` agree.
const SETTINGS_REF: DisclosureRef = {
  variable: SETTINGS_ANCHOR,
  member: SETTINGS_OPEN,
};
const CONFIG_REF: DisclosureRef = {
  variable: CONFIG_SEG,
  member: SETTINGS_OPEN,
};

// [LAW:one-type-per-behavior] Rows are minted from the same CHECKS list the doctor
// folds over, so a new check needs no edit here.
const TOOLS_SEG = `${SETTINGS_NS}tools`;
const TOOLS_REF: DisclosureRef = {
  variable: TOOLS_SEG,
  member: SETTINGS_OPEN,
};
const DOCTOR_SEG = `${SETTINGS_NS}doctor`;
const DOCTOR_RUN_ACTION = `${DOCTOR_SEG}.run`;
const doctorFixAction = (check: string): string => `${DOCTOR_SEG}.fix.${check}`;
const doctorRowSeg = (check: string): string => `${DOCTOR_SEG}.${check}`;

// The `(?)` explaining `persist?` — its body says what the NEXT click does.
const PERSIST_HELP_SEG = `${SETTINGS_NS}help.persist`;

// [LAW:one-source-of-truth] The one cell here authoring a text colour; body cells
// let the band's `textOn` floor decide.
const DOOR_TEXT = { fg: "foreground" } as const;

// [LAW:one-source-of-truth] One accordion key: opening one picker closes the rest.
const PICKER_KEY = `${SETTINGS_NS}pickers`;

// [LAW:types-are-the-program] What differs between "theme" and "padding" is a field.
interface SettingControl {
  readonly name: string;
  readonly sessionKey: string;
  readonly configKey: string;
  // The value the bar is ACTUALLY rendering with, whatever produced it.
  readonly effectiveVar: string;
  readonly glyph: string;
  readonly domain: OptionDomain;
}

// [LAW:one-type-per-behavior] One control shape; these differ only in the keys they
// write and the domain they range [LAW:dataflow-not-control-flow], split by where.
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

// Dual like the pickers; records so every SETTINGS_WRITTEN_KEYS entry traces to one.
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

const PICKER_CONTROLS: readonly SettingControl[] = [
  ...PRIMARY_CONTROLS,
  ...CONFIG_CONTROLS,
];

// [LAW:one-source-of-truth] Every PLAIN key the menu writes — ordinary words a
// config can own, so the key alone cannot say who wrote it.
export const SETTINGS_WRITTEN_KEYS: ReadonlySet<string> = new Set(
  [...PICKER_CONTROLS, WRAP, PADDING].flatMap((c) => [
    c.sessionKey,
    c.configKey,
  ]),
);

// [LAW:one-source-of-truth] Derived from the one name, so a record can never
// name a segment whose picker writes a different setting.
const controlSeg = (name: string): string => `${SETTINGS_NS}${name}`;
const controlApply = (name: string): string => `${SETTINGS_NS}apply.${name}`;
const controlReset = (name: string): string => `${SETTINGS_NS}reset.${name}`;

// [LAW:single-enforcer] The one answer to "is this the global menu's anchor" —
// cross-ref.ts accepts a first placement and rejects a second.
export function isSettingsAnchor(segmentName: string): boolean {
  return segmentName === SETTINGS_ANCHOR;
}

declare const anchored: unique symbol;

// [LAW:parse-dont-validate] A tree KNOWN to contain the anchor — and to have
// inherited no gate the default placement descended into — so there is no missing arm.
type AnchoredRoot = LayoutNode & { readonly [anchored]: true };

// [LAW:dataflow-not-control-flow] The default position as structural recursion,
// not a placement mode. Total over every tree shape, degenerate ones included.
function appendAnchor(node: LayoutNode): LayoutNode {
  const anchorRef: LayoutNode = { kind: "segment", name: SETTINGS_ANCHOR };
  if (node.kind === "segment") {
    // [LAW:no-silent-failure] Carry a bare-segment root's own `when` onto the new
    // wrapper, or everything spliced beside it renders past a gate the author wrote.
    return {
      kind: "container",
      direction: "horizontal",
      children: [node, anchorRef],
      ...(node.when !== undefined && { when: node.when }),
    };
  }
  const [first, ...rest] = node.children;
  // [LAW:no-silent-failure] Descend only into an UNGATED child; inheriting an inner
  // row's gate would delete the menu under the author's condition. The root's stays.
  if (
    node.direction === "vertical" &&
    first !== undefined &&
    first.when === undefined
  ) {
    return { ...node, children: [appendAnchor(first), ...rest] };
  }
  return { ...node, children: [...node.children, anchorRef] };
}

// [LAW:parse-dont-validate] The author's placement passes through byte-identical.
function withAnchor(node: LayoutNode): AnchoredRoot {
  const placed = countAnchors(node) > 0 ? node : appendAnchor(node);
  return placed as AnchoredRoot;
}

// [LAW:single-enforcer] THE anchor census, so "placed" (withAnchor) and "more
// than one" (the loader's duplicate check) cannot mean different things.
export function countAnchors(node: LayoutNode): number {
  let n = 0;
  for (const each of walkNodes(node)) {
    if (each.kind === "segment" && isSettingsAnchor(each.name)) n += 1;
  }
  return n;
}

// [LAW:one-type-per-behavior] The lowering every disclosure takes. `⚙ config`
// nests INSIDE the body, so it cannot render beside a closed menu.
function expandAnchor(
  node: AnchoredRoot | LayoutNode,
  help: SegmentNode,
): LayoutNode {
  if (node.kind === "segment") {
    return isSettingsAnchor(node.name)
      ? disclosureNode(
          node.name,
          SETTINGS_REF,
          {
            kind: "container",
            direction: "horizontal",
            children: [
              { kind: "segment", name: PERSIST_SEG },
              help,
              ...PRIMARY_CONTROLS.map(
                (c): LayoutNode => ({
                  kind: "segment",
                  name: controlSeg(c.name),
                }),
              ),
              disclosureNode(CONFIG_SEG, CONFIG_REF, {
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
              }),
              disclosureNode(TOOLS_SEG, TOOLS_REF, {
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
              }),
              { kind: "segment", name: EDIT_SEG },
            ],
          },
          node.when,
        )
      : // An anchor placed inside a group's body is still the anchor.
        mapOpens(node, (body) => expandContainer(body, help));
  }
  return expandContainer(node, help);
}

function expandContainer<
  N extends { readonly children: readonly LayoutNode[] },
>(node: N, help: SegmentNode): N {
  return {
    ...node,
    children: node.children.map((child) => expandAnchor(child, help)),
  };
}

interface MenuArtifacts {
  readonly variables: Record<string, VariableDecl>;
  readonly actions: Record<string, ActionDecl>;
  readonly segments: Record<string, SegmentDecl>;
}

// [LAW:single-enforcer] Calls the SAME pure functions the parse-time pass calls.
function declareHostedMenu(
  segName: string,
  applyName: string,
  artifacts: MenuArtifacts,
  // [LAW:one-source-of-truth] Artifacts and rendered disclosure, one identity.
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

// [LAW:one-source-of-truth] Minted ONCE per config, REFERENCED per preset root.
function settingsArtifacts(): {
  artifacts: MenuArtifacts;
  help: SegmentNode;
} {
  const artifacts: MenuArtifacts = {
    variables: {
      [SETTINGS_ANCHOR]: disclosureStateVar(SETTINGS_ANCHOR, DISCLOSURE_CLOSED),
    },
    actions: {
      [SETTINGS_ANCHOR]: disclosureCycleAction(SETTINGS_ANCHOR, SETTINGS_OPEN),
      [CONFIG_SEG]: disclosureCycleAction(CONFIG_SEG, SETTINGS_OPEN),
      [TOOLS_SEG]: disclosureCycleAction(TOOLS_SEG, SETTINGS_OPEN),
      [DOCTOR_RUN_ACTION]: { doctor: "run" },
      // [LAW:one-source-of-truth] Off first: an unwritten key is the first member.
      [PERSIST_SEG]: {
        set: PERSIST_KEY,
        cycle: [BOOLEAN_FALSE, BOOLEAN_TRUE],
      },
    },
    segments: {
      // [LAW:representation] The glyph trails the label it gates.
      [SETTINGS_ANCHOR]: {
        template: disclosureTrigger(
          SETTINGS_ANCHOR,
          `☰ ${DISCLOSURE_GLYPH_CLOSED}`,
          `☰ ${DISCLOSURE_GLYPH_OPEN}`,
        ),
        ...DOOR_TEXT,
      },
      // [LAW:representation] The checkbox states what the NEXT write does.
      [PERSIST_SEG]: {
        template: `{{ action "${PERSIST_SEG}" "☐ persist?" "☑ persist?" }}`,
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
      // [LAW:one-type-per-behavior] A toggle and a stepper are one behavior.
      [WRAP_SEG]: {
        template:
          `{{ action "${controlApply("wrap")}" "wrap: on" "wrap: off" }} ` +
          `{{ action "${controlReset("wrap")}" "↺" }}`,
      },
      [PADDING_SEG]: {
        template:
          `{{ action "${controlApply("padding")}.down" "◀" }} ` +
          "padding {{ .padding.effective }} " +
          `{{ action "${controlApply("padding")}.up" "▶" }} ` +
          `{{ action "${controlReset("padding")}" "↺" }}`,
      },
      // `edit.toggle`'s only other reference is in `toolbar`, which a root can drop.
      [EDIT_SEG]: {
        template: `{{ action "${EDIT_TOGGLE_ACTION}" "✎ edit" "✎ done" }}`,
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
  artifacts.variables[TOOLS_SEG] = disclosureStateVar(
    TOOLS_SEG,
    DISCLOSURE_CLOSED,
  );
  declareSettingControls(artifacts);
  declareDoctorRows(artifacts);
  // [LAW:one-source-of-truth] The NODE is returned so `expandAnchor` places it by value.
  const help = declareHelp(
    PERSIST_HELP_SEG,
    PERSIST_HELP,
    [SETTINGS_REF],
    artifacts,
  );
  return { artifacts, help };
}

// [LAW:one-source-of-truth] Keys from the SAME `doctorReportKeys` the verbs write.
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

// [LAW:one-source-of-truth] Minted from the one table that describes them; every
// apply action is DUAL, naming both destinations and the selector between them.
// [LAW:single-enforcer] No gate here — the validator derivations explode the duals.
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
    };
    artifacts.actions[apply] = {
      set: c.sessionKey,
      persist: c.configKey,
      persistWhen: PERSIST_KEY,
      from: c.domain,
    };
    // [LAW:one-source-of-truth] ↺ clears the DURABLE default only.
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
  // [LAW:one-source-of-truth] The same range the loader and both write gates enforce.
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

// [LAW:one-source-of-truth] Ensured, not duplicated: synthesizeEditModeToggle is
// demand-driven off a FILE's segments and cannot see one this pass mints.
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

// [LAW:one-source-of-truth] Named once so the predicate and cross-ref.ts's error agree.
export const SESSION_ID_VAR = "session.id";

// [LAW:types-are-the-program] The one structural prerequisite as a value: every
// click composes a URL beginning with `session.id`, so a config without it is a
// static bar with no menu to place.
// [LAW:one-source-of-truth] THE fact "will the anchor resolve?" — cross-ref.ts
// asks it too, to tell a satisfiable authored placement from a dangling one.
export function canHostSessionState(config: DslConfig): boolean {
  return Object.prototype.hasOwnProperty.call(config.variables, SESSION_ID_VAR);
}

// [LAW:single-enforcer] THE synthesis entry point. Every declared preset gets an
// explicit `presets[name].root`; `config.root` itself is left untouched.
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
