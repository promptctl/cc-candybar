// [LAW:one-type-per-behavior] THE control for a setting, generated from its
// declaration (brandon-settings-coverage-g4p.zoj). Two sources declare
// settings — a segment's per-placement `settings` (configure mode,
// src/config/edit-chrome.ts) and the config's `globals` (the settings menu,
// src/config/settings-menu.ts) — and both hand their declaration to this one
// generator, so a flag is the same toggle, a range the same stepper and a
// list of names the same picker wherever a setting is changed from the bar.
// Where the control is placed stays with each caller; what it IS lives here.
//
// [LAW:one-way-deps] It knows actions, option domains and the disclosure
// helpers — nothing about menus, presets or edit chrome — so both callers
// depend down onto it.

import type { ActionDecl } from "./action.js";
import {
  DISCLOSURE_CLOSED,
  disclosureCycleAction,
  disclosureStateVar,
  escapeTemplateLiteral,
} from "./disclosure.js";
import { menuActionName, menuPageKey } from "./menu-keys.js";
import type {
  DisclosureRef,
  SettingDecl,
  SettingRange,
  VariableDecl,
} from "./dsl-types.js";
import { PLACEMENT_THEMES, type OptionDomain } from "./option-domain.js";
import { BOOLEAN_MEMBERS } from "../themes/policy.js";

// [LAW:types-are-the-program] What a control can range: a flag, a bounded
// integer, or the members of an option domain — a registered name ("themes",
// "styles", …) or an inline list of words. Every declaration a setting source
// can write projects onto one of these three, and the shape of the control
// follows from the arm alone.
export type ControlDomain =
  | "bool"
  | SettingRange
  | { readonly from: OptionDomain };

export interface ControlDecl {
  readonly label: string;
  readonly domain: ControlDomain;
}

// [LAW:types-are-the-program] What the generator hands back, discriminated by
// whether the control opens anything: an `inline` control is one cell of its
// row; a `picker` is `◀ name ▶` — the arrows step, the name opens the list of
// every option (brandon-menu-ia-q30.jl1) — and carries that list: the
// disclosure it opens on and the template of its row. The caller hangs the
// list on the control (`disclosureNode`), with any rows of its own beneath it
// in the same body, so they open, close and lead with one ✕ together. Either
// way it carries the actions and state variables its templates name, so the
// two cannot be separated.
interface AffordanceParts {
  readonly template: string;
  readonly actions: Readonly<Record<string, ActionDecl>>;
  readonly variables: Readonly<Record<string, VariableDecl>>;
}
export interface PickerList {
  readonly ref: DisclosureRef;
  readonly template: string;
}
export type Affordance =
  | (AffordanceParts & { readonly kind: "inline" })
  | (AffordanceParts & { readonly kind: "picker"; readonly list: PickerList });

// A placement setting's declaration as a control: a word list is an inline
// option domain, and the placement's theme ranges the placement themes.
export function controlDeclOf(decl: SettingDecl): ControlDecl {
  return { label: decl.label, domain: controlDomainOf(decl.domain) };
}

// [LAW:types-are-the-program] Total over SettingDecl's domain arms by
// narrowing alone, so a new arm is a compile error here, not a stepper minted
// over an undefined range.
function controlDomainOf(domain: SettingDecl["domain"]): ControlDomain {
  if (domain === "theme") return { from: PLACEMENT_THEMES };
  if (domain === "bool") return domain;
  return "min" in domain ? domain : { from: domain };
}

// The control, and the actions it writes `key` through — named `name` (and
// `name.down`/`name.up` for a stepper). `readVar` is the variable holding the
// value the bar renders with, which a stepper shows between its arrows (a
// picker reads its own through its action's key). `listKey` is the accordion a picker's list
// joins: the lists of one caller's controls share it, so one is open at a time.
//
// [LAW:single-enforcer] Nothing here declares a gate: every action is a `set`
// whose value source is the declared domain, and deriveActionValidators
// derives the key's gate from exactly that, so a click cannot write a value
// the setting may not hold.
export function settingControl(
  decl: ControlDecl,
  key: string,
  readVar: string,
  name: string,
  listKey: string,
): Affordance {
  const label = escapeTemplateLiteral(decl.label);
  const { domain } = decl;
  if (domain === "bool") {
    // The displays match BOOLEAN_MEMBERS position by position: ☑ is true.
    return {
      kind: "inline",
      template: `{{ action "${name}" "☑ ${label}" "☐ ${label}" }}`,
      actions: { [name]: { set: key, cycle: [...BOOLEAN_MEMBERS] } },
      variables: {},
    };
  }
  if ("from" in domain) {
    return optionPicker(label, key, name, listKey, domain.from);
  }
  const step = (by: number): ActionDecl => ({
    set: key,
    min: domain.min,
    max: domain.max,
    by,
  });
  return {
    kind: "inline",
    template:
      `{{ action "${name}.down" "◀" }} ` +
      `{{ "${label}" }} {{ .${readVar} }} ` +
      `{{ action "${name}.up" "▶" }}`,
    actions: {
      [`${name}.down`]: step(-domain.step),
      [`${name}.up`]: step(domain.step),
    },
    variables: {},
  };
}

// [LAW:one-type-per-behavior] A choice among named options, as Brandon drew
// it: `◀ name ▶`, the arrows applying the previous and next option (the bare
// carousel, `{{ carousel … 0 }}`), the name opening a plain list of every
// option — "a regular menu, no carousel" — paged to the width. The list is a
// row of a disclosure body on `listKey`, so the body's ✕ is its close and the
// picker draws none of its own. Opening it starts at the first page.
// [LAW:one-source-of-truth] The toggle and the page cursor are named as a
// shared-key `{{ menu }}` names its own (menu-keys.ts): the list IS a menu body
// on an accordion key, so one cursor per key is exact, and the cursor lives in
// the menu namespace, never under a setting's draft namespace.
function optionPicker(
  label: string,
  key: string,
  name: string,
  listKey: string,
  from: OptionDomain,
): Affordance {
  const ref: DisclosureRef = { variable: listKey, key: listKey, member: name };
  const toggle = menuActionName(listKey, name);
  const open = `${name}.open`;
  const page = menuPageKey(listKey);
  const firstPage = `${page}.first`;
  return {
    kind: "picker",
    template: `{{ "${label}" }} {{ carousel "${name}" 0 "${open}" }}`,
    actions: {
      [name]: { set: key, from },
      [toggle]: disclosureCycleAction(listKey, name),
      [page]: { set: page, int: true },
      [firstPage]: { set: page, to: "0" },
      [open]: { do: [toggle, firstPage] },
    },
    variables: {
      [listKey]: disclosureStateVar(listKey, DISCLOSURE_CLOSED),
      [page]: { kind: "state", key: page, default: "0" },
    },
    list: {
      ref,
      template: `{{ picker "${name}" "${page}" false true true }}`,
    },
  };
}
