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

import type { OptionSource } from "./action.js";
import type { ActionDecl } from "./action.js";
import {
  DISCLOSURE_CLOSED,
  disclosureCycleAction,
  disclosureStateVar,
  escapeTemplateLiteral,
} from "./disclosure.js";
import {
  menuActionName,
  menuPageKey,
  PAGE_HOLDING_CURRENT,
} from "./menu-keys.js";
import type {
  DisclosureRef,
  SettingDecl,
  SettingRange,
  VariableDecl,
} from "./dsl-types.js";
import {
  PLACEMENT_THEMES,
  resolveOptionDomain,
  type OptionDomain,
  type ResolvedDomain,
} from "./option-domain.js";
import {
  BOOLEAN_MEMBERS,
  parseSessionBoolean,
  parseSessionInt,
} from "../themes/policy.js";

// [LAW:types-are-the-program] What a control can range: a flag, a bounded
// integer, the members of an option domain — a registered name ("styles",
// "presets", …) or an inline list of words — or THEMES. Every declaration a
// setting source can write projects onto one of these four, and the shape of
// the control follows from the arm alone. Themes are an arm of their own
// because a theme is chosen by looking at it (brandon-theme-swatch-8v9r): its
// control is the theme picker, swatches and a demo, never a list of names. The
// two domains whose members are themes are the arm's whole range.
export type ThemeDomain = "themes" | typeof PLACEMENT_THEMES;
export type ControlDomain =
  | "bool"
  | SettingRange
  | OptionSource
  | { readonly themes: ThemeDomain };

// The option domain a control over named options ranges.
const optionsOf = (
  domain: { readonly from: OptionDomain } | { readonly themes: ThemeDomain },
): OptionDomain => ("from" in domain ? domain.from : domain.themes);

export interface ControlDecl {
  readonly label: string;
  readonly domain: ControlDomain;
}

// [LAW:types-are-the-program] What the generator hands back, discriminated by
// whether the control opens anything: an `inline` control is one cell of its
// row; a `picker` opens a list of its options — `◀ label ▶`, whose arrows step
// and whose label opens a plain list of every option (brandon-menu-ia-q30.jl1),
// or the theme picker, whose label and swatch open a row of swatches over a
// demo of the selected theme — and carries that list: the disclosure it opens
// on and the template of each of its rows. The caller hangs the list on the
// control (`disclosureNode`), with any rows of its own beneath it in the same
// body, so they open, close and lead with one ✕ together. Either way it
// carries the actions and state variables its templates name, so the two
// cannot be separated.
interface AffordanceParts {
  readonly template: string;
  readonly actions: Readonly<Record<string, ActionDecl>>;
  readonly variables: Readonly<Record<string, VariableDecl>>;
}
export interface PickerList {
  readonly ref: DisclosureRef;
  readonly rows: readonly string[];
}
export type Affordance =
  | (AffordanceParts & { readonly kind: "inline" })
  | (AffordanceParts & { readonly kind: "picker"; readonly list: PickerList });

// [LAW:one-source-of-truth] Whether a control's domain holds `value`, spelled
// as SessionState spells it. The flag and range arms ARE the session parses
// the render resolves a pick with; an option domain's parse is membership of
// the same list the domain names (the GLOBAL_FIELDS row's parse, the installed
// themes, this config's styles and presets), resolved here through the one
// resolveOptionDomain with this config's own domains threaded in as data.
export function controlDomainAdmits(
  domain: ControlDomain,
  value: string,
  perConfigDomains: ReadonlyMap<string, ResolvedDomain>,
): boolean {
  if (domain === "bool") return parseSessionBoolean(value) !== null;
  if (!("min" in domain)) {
    return resolveOptionDomain(
      optionsOf(domain),
      perConfigDomains,
    ).members.includes(value);
  }
  return parseSessionInt(value, domain) !== null;
}

// A domain longer than this reads in a message as its name, its size and a
// few of its members: an error naming every installed theme is a wall of text
// that buries the rest of the message in the diagnostics viewer.
const LISTED_MEMBERS = 8;
const SAMPLED_MEMBERS = 3;

// How a control's domain reads in a message.
export function describeControlDomain(
  domain: ControlDomain,
  perConfigDomains: ReadonlyMap<string, ResolvedDomain>,
): string {
  if (domain === "bool") return BOOLEAN_MEMBERS.join(" or ");
  if (!("min" in domain)) {
    const from = optionsOf(domain);
    const { members } = resolveOptionDomain(from, perConfigDomains);
    const quoted = members.map((m) => JSON.stringify(m));
    if (members.length <= LISTED_MEMBERS) return `one of ${quoted.join(", ")}`;
    const named = typeof from === "string" ? ` "${from}"` : "";
    return `one of the ${members.length}${named} names, such as ${quoted.slice(0, SAMPLED_MEMBERS).join(", ")}`;
  }
  return `an integer from ${domain.min} to ${domain.max}`;
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
  if (domain === "theme") return { themes: PLACEMENT_THEMES };
  if (domain === "bool") return domain;
  return "min" in domain ? domain : { from: domain };
}

// The control, and the actions it writes `key` through — named `name` (and
// `name.down`/`name.up` for a stepper). `readVar` is the variable holding the
// value the bar renders with, which a stepper shows between its arrows and the
// theme picker names while open (an option picker reads its own through its
// action's key). `listKey` is the accordion a picker's list joins: the lists
// of one caller's controls share it, so one is open at a time.
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
    return optionPicker(key, name, listKey, domain, (n) => ({
      template: `{{ carousel "${n.apply}" "${n.open}" "${label}" }}`,
      rows: [`{{ picker "${n.apply}" "${n.page}" false true true }}`],
    }));
  }
  if ("themes" in domain) {
    // The theme picker (design-docs/PROPOSAL-ui-pickers.md, "Theme picker"):
    // closed, the setting's label and the swatch of the theme in force; open,
    // that theme's name and swatch, over the row of swatches and the two-row
    // demo of the theme selected. Brandon: "The name loses its styling and
    // the swatch carries the colour." The name and the swatch are one button
    // (`[Theme [=]]`): each is a link to the same open.
    return optionPicker(key, name, listKey, { from: domain.themes }, (n) => ({
      template: `{{ action "${n.open}" "${label}" .${readVar} }} {{ action "${n.open}" (swatch "${n.apply}") }}`,
      rows: [
        `{{ swatches "${n.apply}" "${n.page}" }}`,
        `{{ themePreview "${n.apply}" }}`,
      ],
    }));
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

// The names a picker's templates bind: the action applying an option, the one
// opening the list (on the page holding the option in force), and the list's
// page cursor.
interface PickerNames {
  readonly apply: string;
  readonly open: string;
  readonly page: string;
}

// What a picker looks like: the control's own template, and the rows of the
// list it opens, first to last.
interface PickerFace {
  readonly template: string;
  readonly rows: readonly string[];
}

// [LAW:one-type-per-behavior] A choice among named options, whatever it looks
// like: an apply action over the domain, the list on `listKey` that the
// control opens, and the page cursor of that list. The list is a disclosure
// body on `listKey`, so the body's ✕ is its close and no row draws one of its
// own. Opening it shows the page holding the option in force. What the
// control and its rows SHOW is the face — `◀ label ▶` over a plain list of
// every option, "a regular menu, no carousel", or the theme picker — and only
// the face differs.
// [LAW:one-source-of-truth] The toggle and the page cursor are named as a
// shared-key `{{ menu }}` names its own (menu-keys.ts): the list IS a menu body
// on an accordion key, so one cursor per key is exact, and the cursor lives in
// the menu namespace, never under a setting's draft namespace.
function optionPicker(
  key: string,
  name: string,
  listKey: string,
  source: OptionSource,
  face: (names: PickerNames) => PickerFace,
): Affordance {
  const ref: DisclosureRef = { variable: listKey, key: listKey, member: name };
  const toggle = menuActionName(listKey, name);
  const open = `${name}.open`;
  const page = menuPageKey(listKey);
  const currentPage = `${page}.current`;
  const { template, rows } = face({ apply: name, open, page });
  return {
    kind: "picker",
    template,
    actions: {
      [name]: { set: key, ...source },
      [toggle]: disclosureCycleAction(listKey, name),
      [page]: { set: page, int: true },
      [currentPage]: { set: page, to: PAGE_HOLDING_CURRENT },
      [open]: { do: [toggle, currentPage] },
    },
    variables: {
      [listKey]: disclosureStateVar(listKey, DISCLOSURE_CLOSED),
      [page]: { kind: "state", key: page, default: "0" },
    },
    list: { ref, rows },
  };
}
