// [LAW:one-type-per-behavior] THE control for a setting, generated from its
// declaration (brandon-settings-coverage-g4p.zoj). Two sources declare
// settings — a segment's per-placement `settings` (configure mode,
// src/config/edit-chrome.ts) and the config's `globals` (the settings menu,
// src/config/settings-menu.ts) — and both hand their declaration to this one
// generator, so a flag is the same toggle, a range the same stepper and a
// list of names the same carousel wherever a setting is changed from the bar.
// Where the control is placed stays with each caller; what it IS lives here.
//
// [LAW:one-way-deps] It knows actions, option domains and the disclosure
// helpers — nothing about menus, presets or edit chrome — so both callers
// depend down onto it.

import type { ActionDecl } from "./action.js";
import { escapeTemplateLiteral } from "./disclosure.js";
import type { SettingDecl, SettingRange } from "./dsl-types.js";
import { PLACEMENT_THEMES, type OptionDomain } from "./option-domain.js";
import { BOOLEAN_MEMBERS } from "../themes/policy.js";

// [LAW:types-are-the-program] What a control can range: a flag, a bounded
// integer, or the members of an option domain — a registered name ("themes",
// "looks", …) or an inline list of words. Every declaration a setting source
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
// how much room the control needs: an `inline` control is one cell of its
// row; a `ring` is a carousel, which fills the row it is given with the
// neighbours that fit — so a caller gives it a row of its own, and puts the
// setting's label wherever that caller labels things.
export type Affordance =
  | { readonly kind: "inline"; readonly template: string }
  | { readonly kind: "ring"; readonly template: string };

// A placement setting's declaration as a control: a word list is an inline
// option domain, and the placement's theme ranges the placement themes.
export function controlDeclOf(decl: SettingDecl): ControlDecl {
  const { domain } = decl;
  return {
    label: decl.label,
    domain:
      domain === "theme"
        ? { from: PLACEMENT_THEMES }
        : Array.isArray(domain)
          ? { from: domain }
          : (domain as "bool" | SettingRange),
  };
}

// The control, and the actions it writes `key` through — minted into
// `actions` under `name` (and `name.down`/`name.up` for a stepper). `readVar`
// is the variable holding the value the bar renders with, which a stepper
// shows between its arrows.
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
  actions: Record<string, ActionDecl>,
): Affordance {
  const label = escapeTemplateLiteral(decl.label);
  const { domain } = decl;
  if (domain === "bool") {
    // The displays match BOOLEAN_MEMBERS position by position: ☑ is true.
    actions[name] = { set: key, cycle: [...BOOLEAN_MEMBERS] };
    return {
      kind: "inline",
      template: `{{ action "${name}" "☑ ${label}" "☐ ${label}" }}`,
    };
  }
  if ("from" in domain) {
    actions[name] = { set: key, from: domain.from };
    return { kind: "ring", template: `{{ carousel "${name}" }}` };
  }
  for (const by of [-domain.step, domain.step]) {
    actions[`${name}.${by < 0 ? "down" : "up"}`] = {
      set: key,
      min: domain.min,
      max: domain.max,
      by,
    };
  }
  return {
    kind: "inline",
    template:
      `{{ action "${name}.down" "◀" }} ` +
      `{{ "${label}" }} {{ .${readVar} }} ` +
      `{{ action "${name}.up" "▶" }}`,
  };
}
