// [LAW:one-source-of-truth] THE derivation of a menu's disclosure identity: a `{{ menu }}` cannot see its own segment, so the loader and the renderer both derive it from the host segment name plus the apply name and MUST agree.
// [LAW:decomposition] Identity is (stateKey, member); [LAW:dataflow-not-control-flow] an explicit shared key makes siblings an accordion — a VALUE, not a mode.

import { ident } from "./ident.js";
import {
  DEFAULT_DISTRIBUTION,
  DISTRIBUTION_NAMES,
  isDistributionName,
  placedBy,
  type Distribution,
} from "../themes/decor.js";

// [LAW:one-source-of-truth] The reserved namespace for synthesized menu artifacts; a user-authored name under it is a load error.
export const MENU_NS = "menus.";

// [LAW:single-enforcer] A menu's member name IS its apply-action name.
export function menuMember(applyName: string): string {
  return applyName;
}

// [LAW:single-enforcer] Independent: unique per (segment, apply), so the menu toggles
// only itself. Shared: siblings agree on one key, so one open member wins.
export function menuStateKey(
  segName: string,
  applyName: string,
  sharedKey: string | undefined,
): string {
  return sharedKey !== undefined
    ? MENU_NS + ident(sharedKey)
    : MENU_NS + ident(segName) + "." + ident(applyName);
}

// Named per (stateKey, member) so menus sharing a key contribute distinct cycles, which the same-key validator merge unions into one gate.
export function menuActionName(stateKey: string, member: string): string {
  return stateKey + "." + member;
}

// [LAW:single-enforcer] One cursor PER DISCLOSURE STATE KEY, not per menu: a shared
// key holds at most one open member, so sharing is exact by construction.
export function menuPageKey(stateKey: string): string {
  return stateKey + ".page";
}

export interface MenuOptions {
  readonly closeOnPick: boolean;
  readonly paged: boolean;
  readonly key: string | undefined;
  // [LAW:parse-dont-validate] Already resolved; absent ≡ van der Corput.
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

// [LAW:one-source-of-truth] THE reader of a menu's options dict — loader and renderer both fold it, so vocabulary, types and defaults live exactly once.
// [LAW:no-silent-failure] An unknown name or mistyped value throws naming the shape.
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
  // [LAW:types-are-the-program] An empty key would collapse the state key to the bare reserved namespace; a key, when present, must name a group.
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
