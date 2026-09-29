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
// setting's label wherever that caller labels things. Either way it carries
// the actions its template names, so the two cannot be separated.
export interface Affordance {
  readonly kind: "inline" | "ring";
  readonly template: string;
  readonly actions: Readonly<Record<string, ActionDecl>>;
}

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
// `name.down`/`name.up` for a stepper). `readVar`
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
): Affordance {
  const label = escapeTemplateLiteral(decl.label);
  const { domain } = decl;
  if (domain === "bool") {
    // The displays match BOOLEAN_MEMBERS position by position: ☑ is true.
    return {
      kind: "inline",
      template: `{{ action "${name}" "☑ ${label}" "☐ ${label}" }}`,
      actions: { [name]: { set: key, cycle: [...BOOLEAN_MEMBERS] } },
    };
  }
  if ("from" in domain) {
    return {
      kind: "ring",
      template: `{{ carousel "${name}" }}`,
      actions: { [name]: { set: key, from: domain.from } },
    };
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
  };
}
