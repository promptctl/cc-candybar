// The session state a placement owns, and the placements a config places.
//
// [LAW:one-source-of-truth] A placement's session state is keyed by its preset
// and id alone (edit-chrome.ts spells every key), so a placement that ends
// leaves keys behind that the next placement to take its id would inherit.
// Which keys those are is read back off the key here, beside nothing else: no
// file, layer or session is consulted, because the judgment is the session's
// own config's — it places the owner, or it does not.

import { DISCLOSURE_CLOSED } from "./disclosure.js";
import { placementIds, type DslConfig } from "./dsl-types.js";
import { escapedIdent } from "./ident.js";
import { EDIT_CONFIGURE_KEY, PLACEMENT_DRAFT_NS } from "./loader/edit-mode.js";
import { presetNames, presetRoot } from "./presets.js";
import { MENU_NS, MENU_PAGE_NS } from "./reserved-names.js";

// [LAW:types-are-the-program] A placement as its state names it: the preset
// and the id, each in its injective escaped spelling, which holds no `.`, so
// one owner is one string.
export type PlacementOwner = string & { readonly __placementOwner: never };

function ownerOf(presetIdent: string, placementIdent: string): PlacementOwner {
  return `${presetIdent}.${placementIdent}` as PlacementOwner;
}

// What a config places, as a judgment of owners: the loaded config's, or a
// failed load's, which judges nothing gone, since the config the session's
// files hold is the one that did not load.
export interface Placements {
  has(owner: PlacementOwner): boolean;
}

export const EVERY_PLACEMENT_STANDS: Placements = { has: () => true };

// [LAW:one-source-of-truth] Every placement the config places, in every
// preset, inserts included: the trees as the loader placed them, the same
// trees an insertion mints its id over. Built once per loaded config.
export function placementsOf(
  config: Pick<DslConfig, "presets" | "root">,
): Placements {
  return new Set(
    presetNames(config.presets).flatMap((preset) =>
      placementIds(presetRoot(config, preset).node).map((id) =>
        ownerOf(escapedIdent(preset), escapedIdent(id)),
      ),
    ),
  );
}

// The `{{ menu }}` state keys edit chrome mints for one placement: a `✚`
// gap's library beside it, and its configure controls' lists. Each spells the
// preset and the placement escaped, so `ident` keeps them as they are and
// `_` only ever separates. An authored menu key cannot collapse under
// `menus.edit_` (the loader refuses a reserved namespace in `ident` space),
// so nothing an author's `{{ menu }}` holds is read as a placement's.
const GAP_MENU =
  /^edit_([A-Za-z0-9]+)_insertSeg_(before|after)_([A-Za-z0-9]+)\.edit_\1_insert_\2_\3$/;
const CONFIGURE_LIST = /^edit_([A-Za-z0-9]+)_configure_([A-Za-z0-9]+)$/;

function menuOwner(key: string): PlacementOwner | null {
  const menu = key.startsWith(MENU_PAGE_NS)
    ? key.slice(MENU_PAGE_NS.length)
    : key;
  if (!menu.startsWith(MENU_NS)) return null;
  const name = menu.slice(MENU_NS.length);
  const gap = GAP_MENU.exec(name);
  if (gap !== null) return ownerOf(gap[1]!, gap[3]!);
  const list = CONFIGURE_LIST.exec(name);
  return list === null ? null : ownerOf(list[1]!, list[2]!);
}

// A draft key is `<ns><preset>.<id>.<setting>`: the preset holds no `.` and
// the setting is an identifier, so the id is everything between.
function draftOwner(key: string): PlacementOwner | null {
  if (!key.startsWith(PLACEMENT_DRAFT_NS)) return null;
  const rest = key.slice(PLACEMENT_DRAFT_NS.length);
  const preset = rest.indexOf(".");
  const setting = rest.lastIndexOf(".");
  return ownerOf(
    rest.slice(0, preset),
    escapedIdent(rest.slice(preset + 1, setting)),
  );
}

// The configure key holds `<preset>:<id>` while a placement is configured,
// and the id holds no `:`.
function configuringOwner(value: string): PlacementOwner | null {
  if (value === DISCLOSURE_CLOSED) return null;
  const at = value.indexOf(":");
  return ownerOf(value.slice(0, at), escapedIdent(value.slice(at + 1)));
}

// [LAW:single-enforcer] The placement a session key holds state for, or null
// for a key no placement owns (an author's menu, a setting, edit mode).
export function placementHolding(
  key: string,
  value: string,
): PlacementOwner | null {
  return key === EDIT_CONFIGURE_KEY
    ? configuringOwner(value)
    : (draftOwner(key) ?? menuOwner(key));
}
