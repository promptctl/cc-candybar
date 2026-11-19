// [LAW:one-source-of-truth] THE derivation of a menu's disclosure identity — the
// single place both the loader (which SYNTHESIZES the state var + cycle action)
// and the renderer (which READS openness + emits the toggle) agree on "which key
// holds which open menu". A `{{ menu }}` helper is context-free about its NAME
// (it cannot see the placement it sits in), so the loader and the render walk
// both derive identity from the same two facts — the host placement's id
// (`placementId`) and the menu's own apply-action name — and MUST produce
// identical strings or a click would
// write a key the render never reads. Keeping the rule in one module makes that
// agreement structural rather than a coincidence of two copies.
//
// [LAW:decomposition] A menu's identity is `(stateKey, member)`:
//   • member  = the menu's apply-action name — unique per menu within a segment,
//               so two menus in ONE segment are distinct.
//   • stateKey = the SessionState key whose value names the open member. By
//               DEFAULT each menu owns a key of its own, named by its placement
//               and its apply action, so it toggles only itself — menus are
//               INDEPENDENT, and two placements of one segment are two menus.
//               Passing an explicit shared key makes sibling menus share one
//               key; one key holds one open member, so they become mutually
//               exclusive (an accordion) — exactly group sugar's shared-key
//               mechanism, selected by a VALUE not a mode
//               [LAW:dataflow-not-control-flow]. There is no implicit "the row
//               is the key" position magic: identity depends only on names a
//               reader can see in the template, never on tree position.
//
// [LAW:types-are-the-program] Every key is spelled injectively and prefix-free:
// `menus.`, a scope, then one dot-free token built from `escapedIdent` (letters
// and digits only) around a tag letter — `k` for a named accordion, `p` for a
// placed menu with `_` between its placement and its apply action. No two
// names share a key, and no key is a dot-path prefix of another, which the
// store would read as a parent (loader/nesting.ts). An author's menu has the
// empty scope; a synthesized one has the namespace of the pass that mints it
// or of the placement that hosts it, which no author token reaches, so a menu
// edit chrome hosts is edit chrome by its key alone (reserved-names.ts).

import { escapedIdent } from "./ident.js";
import { MENU_NS, MENU_PAGE_NS, namespaceOf } from "./reserved-names.js";
import {
  DEFAULT_DISTRIBUTION,
  DISTRIBUTION_NAMES,
  isDistributionName,
  placedBy,
  type Distribution,
} from "../themes/decor.js";

// [LAW:one-source-of-truth] The closed sentinel and the ▸/▾ glyphs are the shared
// disclosure primitive, not menu-specific — they live in src/config/disclosure.ts
// (DISCLOSURE_CLOSED / DISCLOSURE_GLYPH_*) so group sugar and {{ menu }} cannot
// drift. This module keeps only the menu's own IDENTITY derivation (member = apply
// name; key = optional shared key), which group sugar derives differently.

// [LAW:single-enforcer] A menu's member name IS its apply-action name. Both the
// loader and the helper call this so neither restates the rule.
// [LAW:one-source-of-truth] The page cursor's value for "the page holding the
// option in force": a picker reads any page below zero that way
// (render/picker.ts), so a list opened with it opens where its value is.
export const PAGE_HOLDING_CURRENT = "-1";

export function menuMember(applyName: string): string {
  return applyName;
}

// [LAW:single-enforcer] THE state key for a menu. Independent (no shared key):
// unique per (placement, apply) so the menu toggles only itself. Shared key:
// the key all siblings passing the same string agree on, so one open member
// wins (accordion). The shared form ignores the placement on purpose — that is
// how menus in DIFFERENT placements become mutually exclusive.
export function menuStateKey(
  placementId: string,
  applyName: string,
  sharedKey: string | undefined,
): string {
  return sharedKey !== undefined
    ? sharedMenuStateKey(sharedKey)
    : `${MENU_NS}${namespaceOf(placementId) ?? ""}p${escapedIdent(placementId)}_${escapedIdent(applyName)}`;
}

// [LAW:one-source-of-truth] THE key of an accordion named `name` in `scope`:
// an author's shared `{{ menu }}` key in the empty scope, and each synthesized
// accordion (the settings menu's pickers, a placement's configure lists) in
// the namespace of the pass that mints it, where no author spelling reaches.
export function accordionKey(scope: string, name: string): string {
  return `${MENU_NS}${scope}k${escapedIdent(name)}`;
}

// The shared arm of a menu's key: an authored accordion key.
export function sharedMenuStateKey(sharedKey: string): string {
  return accordionKey("", sharedKey);
}

// The synthesized cycle action a menu's disclosure toggle realizes: writing its
// state key between MENU_CLOSED and its member. Named per (stateKey, member) so
// menus sharing a key contribute distinct cycles on it — the existing same-key
// validator merge unions their members into one gate. The member is escaped,
// so the name is one token after the key and no toggle's name prefixes another.
export function menuActionName(stateKey: string, member: string): string {
  return `${stateKey}.${escapedIdent(member)}`;
}

// [LAW:single-enforcer] THE page-cursor key a menu's picker body paginates by —
// synthesized by the loader (state var + int action, both named by this key)
// and derived again by the renderer, so neither side hand-declares or restates
// it. One cursor PER DISCLOSURE STATE KEY, not per menu: a shared (accordion)
// key holds at most one open member, so its one open body is the only body the
// cursor can belong to — sharing is exact by construction, not an
// approximation — and the disclosure toggle's page-0 reset re-seeds it on
// every open. [LAW:one-source-of-truth] The synthesized state VARIABLE is
// named by this same string (the disclosure-var convention), so the renderer
// reads the live page via this one name. It sits in its own reserved
// namespace, beside the state key rather than under it, so no cursor is a
// dot-path prefix of a state key.
export function menuPageKey(stateKey: string): string {
  return MENU_PAGE_NS + stateKey;
}

// The action that turns a page cursor to the page holding the option in
// force: the cursor's name and a suffix no escaped token carries, so it is
// neither the cursor's own action nor under it.
export function menuPageCurrentAction(stateKey: string): string {
  return `${menuPageKey(stateKey)}_current`;
}

// [LAW:types-are-the-program] The `{{ menu }}` rare-knob options, spelled as ONE
// trailing `(dict …)` argument. Defaults are the canonical path: paged=true (a
// drop menu wants bounded height; a short domain paginates to one page and shows
// no arrows anyway), closeOnPick=false (stay-open so options can be tried in a
// row), key omitted (an independent menu).
export interface MenuOptions {
  readonly closeOnPick: boolean;
  readonly paged: boolean;
  readonly key: string | undefined;
  // [LAW:parse-dont-validate] The band's placer field, already resolved: the
  // SAME `distribution` a container carries (dsl-types ContainerNode) — a menu
  // is an instance too, and its band places its options by this. An authored
  // name is validated against DISTRIBUTION_NAMES here; absent ≡ van der Corput.
  readonly distribution: Distribution;
}

const MENU_OPTION_NAMES = [
  "closeOnPick",
  "paged",
  "key",
  "distribution",
] as const;
type MenuOptionName = (typeof MENU_OPTION_NAMES)[number];
const isMenuOptionName = (name: string): name is MenuOptionName =>
  (MENU_OPTION_NAMES as readonly string[]).includes(name);
export const MENU_OPTIONS_VOCABULARY =
  `"closeOnPick" (bool, default false), "paged" (bool, default true), ` +
  `"key" (string, accordion grouping), "distribution" (one of ${DISTRIBUTION_NAMES.map((n) => `"${n}"`).join(", ")}; default "${DEFAULT_DISTRIBUTION}")`;

// [LAW:one-source-of-truth] THE reader of a menu's options dict — the loader
// folds it over `staticDictEntries` (gating identity at load) and the renderer
// folds it over the evaluated dict object (realizing the body), so the option
// vocabulary, value types, and defaults live exactly once. An unknown name or a
// mistyped value throws with text naming the legal shape — the blind authoring
// agent's teaching channel [LAW:no-silent-failure]; the loader attaches segment
// context, the renderer surfaces it as the bar's error.
export function parseMenuOptions(
  entries: Readonly<Record<string, unknown>>,
): MenuOptions {
  for (const name of Object.keys(entries)) {
    if (!isMenuOptionName(name)) {
      throw new Error(
        `unknown {{ menu }} option "${name}" — the options dict takes ${MENU_OPTIONS_VOCABULARY}`,
      );
    }
  }
  const bool = (name: "closeOnPick" | "paged", def: boolean): boolean => {
    const v = entries[name];
    if (v === undefined) return def;
    if (typeof v !== "boolean") {
      throw new Error(
        `{{ menu }} option "${name}" must be a boolean, got ${JSON.stringify(v)} (e.g. (dict "${name}" ${String(!def)}))`,
      );
    }
    return v;
  };
  const key = entries["key"];
  if (key !== undefined && typeof key !== "string") {
    throw new Error(
      `{{ menu }} option "key" must be a string naming the accordion group, got ${JSON.stringify(key)}`,
    );
  }
  // [LAW:types-are-the-program] An empty shared key would collapse the state key
  // to the bare reserved `menus.` namespace (and a `menus..member` action name) —
  // a key, when present, must name a group.
  if (key === "") {
    throw new Error(
      `{{ menu }} has an empty accordion key — a shared key must be a non-empty name (or omit "key" for an independent menu)`,
    );
  }
  const distribution = entries["distribution"];
  if (distribution !== undefined && !isDistributionName(distribution)) {
    throw new Error(
      `{{ menu }} option "distribution" must be one of: ${DISTRIBUTION_NAMES.join(", ")}; got ${JSON.stringify(distribution)}`,
    );
  }
  return {
    closeOnPick: bool("closeOnPick", false),
    paged: bool("paged", true),
    key,
    distribution: placedBy(distribution),
  };
}
