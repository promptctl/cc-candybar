// [LAW:one-source-of-truth] The one spelling of every session key a placement
// owns — its unsaved values (drafts), its configure list, the ✚ libraries
// beside it and their page cursors, and the configure key's value naming it —
// in both of its forms, and the one reading of each back.
//
// A placement's end is a fact about two loads of what places it, and several
// configs can place one preset and id. So a key the session store holds names
// its OWNER: the chain prefix, the ordered config files whose merge placed it.
// A load can then release a key by reading the key alone, and a key never
// lands on another config's placement that takes its id.
//
// [LAW:one-source-of-truth] The compile is shared by every entry whose config
// compiles alike (.claude/memory/daemon-memory.md), so it captures nothing
// that differs per directory, an owner included: the config, its compile and
// its links spell every key OWNER-FREE. A session's view of the store adds the
// owner at one seam (src/renderer/owned-store.ts), and the store holds only
// the OWNED form.
//
// [LAW:single-enforcer] Every reading of a key is checked by minting it again:
// a text the minter would not produce reads as nothing, so the minter stays
// the one authority and no pattern here can drift from it.

import { createHash } from "node:crypto";
import { escapedIdent, unescapedIdent } from "./ident.js";
import { menuPageKey, menuStateKey, sharedMenuStateKey } from "./menu-keys.js";
import { EDIT_NS, MENU_NS, MENU_PAGE_NS } from "./reserved-names.js";
import { EDIT_CONFIGURE_KEY, PLACEMENT_DRAFT_NS } from "./loader/edit-mode.js";
import { placementId, walkNodes, type DslConfig } from "./dsl-types.js";
import { presetNames, presetRoot } from "./presets.js";
import type { LoadedChain } from "./dsl-loader.js";

// [LAW:types-are-the-program] What owns a placement's session state: a chain
// prefix, spelled `o` and 16 hex digits of the digest of its files, lowest
// first. The bundled default alone is the empty chain.
export type Owner = string & { readonly __placementOwner: unique symbol };

export function chainOwner(paths: readonly string[]): Owner {
  const digest = createHash("sha256")
    .update(JSON.stringify(paths))
    .digest("hex");
  return `o${digest.slice(0, 16)}` as Owner;
}

const OWNER = "(o[0-9a-f]{16})";
// An `escapedIdent` spelling: letters and digits, never a `.`, `_` or `:`,
// so every field below is told apart from its neighbours.
const SPELT = "([A-Za-z0-9]+)";
const RELATION = "(before|after)";

// A placement: the preset whose tree holds it and its id there, as written.
export interface Placement {
  readonly preset: string;
  readonly id: string;
}

export interface Draft extends Placement {
  readonly setting: string;
}

export interface Gap extends Placement {
  readonly relation: "before" | "after";
}

// [LAW:one-type-per-behavior] One family: how its owner-free form and its
// owned form are spelled, and how each reads back.
export interface Family<A extends Placement> {
  // The owner-free form: what the config, the compile and the links name.
  readonly mint: (at: A) => string;
  // The owned form of an owner-free text, or null when the text is not this
  // family's owner-free form.
  readonly own: (text: string, owner: Owner) => string | null;
  // The placement an owner-free text names, or null.
  readonly free: (text: string) => A | null;
  // The owner and placement an owned text names, or null.
  readonly read: (
    text: string,
  ) => { readonly owner: Owner; readonly at: A } | null;
}

function family<A extends Placement>(spelling: {
  readonly mint: (at: A) => string;
  readonly owned: (at: A, owner: Owner) => string;
  // Each reads the escaped fields in the order `at` names them; `stored`
  // captures the owner first.
  readonly free: RegExp;
  readonly stored: RegExp;
  readonly at: (fields: readonly string[]) => A | null;
}): Family<A> {
  const free = (text: string): A | null => {
    const m = spelling.free.exec(text);
    const at = m === null ? null : spelling.at(m.slice(1));
    return at !== null && spelling.mint(at) === text ? at : null;
  };
  return {
    mint: spelling.mint,
    free,
    own: (text, owner) => {
      const at = free(text);
      return at === null ? null : spelling.owned(at, owner);
    },
    read: (text) => {
      const m = spelling.stored.exec(text);
      const owner = m?.[1] as Owner | undefined;
      const at = m === null ? null : spelling.at(m.slice(2));
      return at !== null &&
        owner !== undefined &&
        spelling.owned(at, owner) === text
        ? { owner, at }
        : null;
    },
  };
}

// A family's page cursors: `menupages.` before either of its forms.
function paged<A extends Placement>(menu: Family<A>): Family<A> {
  const under = (text: string): string | null =>
    text.startsWith(MENU_PAGE_NS) ? text.slice(MENU_PAGE_NS.length) : null;
  return {
    mint: (at) => menuPageKey(menu.mint(at)),
    own: (text, owner) => {
      const inner = under(text);
      const owned = inner === null ? null : menu.own(inner, owner);
      return owned === null ? null : MENU_PAGE_NS + owned;
    },
    free: (text) => {
      const inner = under(text);
      return inner === null ? null : menu.free(inner);
    },
    read: (text) => {
      const inner = under(text);
      return inner === null ? null : menu.read(inner);
    },
  };
}

const placementOf = (preset: string, id: string): Placement | null => {
  const p = unescapedIdent(preset);
  const i = unescapedIdent(id);
  return p === null || i === null ? null : { preset: p, id: i };
};

const esc = escapedIdent;

// [LAW:one-source-of-truth] THE session key an unsaved value of one
// placement's setting lives at: the preset (an id is unique only in the tree
// one preset renders), the id, and the setting. A setting name is an
// identifier and both names are escaped, so the key names one value.
export const DRAFTS: Family<Draft> = family<Draft>({
  mint: ({ preset, id, setting }) =>
    `${PLACEMENT_DRAFT_NS}${esc(preset)}.${esc(id)}.${setting}`,
  owned: ({ preset, id, setting }, owner) =>
    `${PLACEMENT_DRAFT_NS}${owner}.${esc(preset)}.${esc(id)}.${setting}`,
  free: new RegExp(
    `^${dots(PLACEMENT_DRAFT_NS)}${SPELT}\\.${SPELT}\\.([^.]+)$`,
  ),
  stored: new RegExp(
    `^${dots(PLACEMENT_DRAFT_NS)}${OWNER}\\.${SPELT}\\.${SPELT}\\.([^.]+)$`,
  ),
  at: ([preset = "", id = "", setting = ""]) => {
    const at = placementOf(preset, id);
    return at === null ? null : { ...at, setting };
  },
});

// The shared `{{ menu }}` key one placement's setting pickers accordion on.
export const CONFIGURE_LISTS: Family<Placement> = family<Placement>({
  mint: ({ preset, id }) =>
    sharedMenuStateKey(`${EDIT_NS}${esc(preset)}.configure.${esc(id)}`),
  owned: ({ preset, id }, owner) =>
    `${MENU_NS}edit_${owner}_${esc(preset)}_configure_${esc(id)}`,
  free: new RegExp(`^${dots(MENU_NS)}edit_${SPELT}_configure_${SPELT}$`),
  stored: new RegExp(
    `^${dots(MENU_NS)}edit_${OWNER}_${SPELT}_configure_${SPELT}$`,
  ),
  at: ([preset = "", id = ""]) => placementOf(preset, id),
});

// [LAW:one-source-of-truth] The names of the `+` gap beside one placement,
// from the preset's and the placement's names as written: its insert action,
// the segment that hosts its menu, and that menu's open state (the ✚
// library). Each spells its preset and placement with `escapedIdent`, so an
// add, removal or move elsewhere hands none of a placement's state to a
// neighbour.
export function insertGap(
  preset: string,
  anchor: string,
  relation: "before" | "after",
): {
  readonly apply: string;
  readonly host: string;
  readonly stateKey: string;
} {
  const gap = `${relation}.${esc(anchor)}`;
  const apply = `${EDIT_NS}${esc(preset)}.insert.${gap}`;
  const host = `${EDIT_NS}${esc(preset)}.insertSeg.${gap}`;
  return { apply, host, stateKey: menuStateKey(host, apply, undefined) };
}

export const LIBRARIES: Family<Gap> = family<Gap>({
  mint: ({ preset, id, relation }) => insertGap(preset, id, relation).stateKey,
  owned: ({ preset, id, relation }, owner) =>
    `${MENU_NS}edit_${owner}_${esc(preset)}_insert_${relation}_${esc(id)}`,
  // The tail repeats the head's fields; re-minting checks they agree.
  free: new RegExp(
    `^${dots(MENU_NS)}edit_${SPELT}_insertSeg_${RELATION}_${SPELT}\\.edit_[A-Za-z0-9]+_insert_(?:before|after)_[A-Za-z0-9]+$`,
  ),
  stored: new RegExp(
    `^${dots(MENU_NS)}edit_${OWNER}_${SPELT}_insert_${RELATION}_${SPELT}$`,
  ),
  at: ([preset = "", relation = "", id = ""]) => {
    const at = placementOf(preset, id);
    return at === null || (relation !== "before" && relation !== "after")
      ? null
      : { ...at, relation };
  },
});

// [LAW:one-source-of-truth] The value of the configure key that configures
// one placement: an id is unique only within one preset's tree, so the
// preset rides with it, and both are escaped, so `:` splits them exactly.
export const CONFIGURING: Family<Placement> = family<Placement>({
  mint: ({ preset, id }) => `${esc(preset)}:${esc(id)}`,
  owned: ({ preset, id }, owner) => `${owner}:${esc(preset)}:${esc(id)}`,
  free: new RegExp(`^${SPELT}:${SPELT}$`),
  stored: new RegExp(`^${OWNER}:${SPELT}:${SPELT}$`),
  at: ([preset = "", id = ""]) => placementOf(preset, id),
});

export const placementDraftKey = (
  preset: string,
  id: string,
  setting: string,
): string => DRAFTS.mint({ preset, id, setting });

export const configureMember = (preset: string, id: string): string =>
  CONFIGURING.mint({ preset, id });

// Every family a key can be in. The configure key's own name is no family's:
// its VALUE is the configuring family.
// Read only: a family's minter takes its own placement shape.
const KEY_FAMILIES: ReadonlyArray<Omit<Family<Placement>, "mint">> = [
  DRAFTS,
  CONFIGURE_LISTS,
  LIBRARIES,
  paged(CONFIGURE_LISTS),
  paged(LIBRARIES),
];

// The owned form of an owner-free family key, or the key itself when it is
// no family's. `owner` is asked only for a family's key: a click naming no
// session that has rendered has no owner, and writes none of these.
export function ownedKey(key: string, owner: () => Owner): string {
  for (const f of KEY_FAMILIES)
    if (f.free(key) !== null) return f.own(key, owner())!;
  return key;
}

// The value `key` stores for `value`: a configure member is stored owned;
// every other value as it is.
export function ownedValue(
  key: string,
  value: string,
  owner: () => Owner,
): string {
  return isOwnerFreeValue(key, value)
    ? CONFIGURING.own(value, owner())!
    : value;
}

// What a stored value of `key` reads as under `owner`: a configure member
// `owner` holds, owner-free; a member another owner holds, or one in a form
// naming no owner, configures nothing here (null: the key's default).
export function freeValue(
  key: string,
  value: string | null,
  owner: () => Owner,
): string | null {
  if (key !== EDIT_CONFIGURE_KEY || value === null || !isMember(value))
    return value;
  const read = CONFIGURING.read(value);
  return read !== null && read.owner === owner()
    ? CONFIGURING.mint(read.at)
    : null;
}

// A configure value naming a placement, in either form: `closed` holds no `:`.
const isMember = (value: string): boolean => value.includes(":");

// [LAW:single-enforcer] The store's checkpoint: a key in owner-free form
// names no owner, so the store refuses to hold or read one.
export function isOwnerFree(key: string): boolean {
  return KEY_FAMILIES.some((f) => f.free(key) !== null);
}

export function isOwnerFreeValue(key: string, value: string): boolean {
  return key === EDIT_CONFIGURE_KEY && CONFIGURING.free(value) !== null;
}

// A draft key in either form: the settings history steps the owned one, and
// the navigation history, above the owner, leaves out the owner-free one.
export const isDraftKey = (key: string): boolean =>
  DRAFTS.read(key) !== null || DRAFTS.free(key) !== null;

// [LAW:types-are-the-program] What one stored (key, value) is to a release:
// a placement's, under its owner; a family's in a form that names no owner
// (`old`), which no load can scope and so every load releases; or no
// family's (`foreign`), an author's `{{ menu }}` key among them.
export type Classified =
  | {
      readonly kind: "owned";
      readonly owner: Owner;
      readonly member: string;
    }
  | { readonly kind: "old" }
  | { readonly kind: "foreign" };

const FOREIGN: Classified = { kind: "foreign" };
const OLD: Classified = { kind: "old" };

const owned = (owner: Owner, at: Placement): Classified => ({
  kind: "owned",
  owner,
  member: CONFIGURING.mint(at),
});

// `value` is read only for the configure key, whose value is the family.
export function classify(key: string, value: () => string | null): Classified {
  if (key === EDIT_CONFIGURE_KEY) {
    const v = value();
    const read = v === null ? null : CONFIGURING.read(v);
    if (read !== null) return owned(read.owner, read.at);
    return v !== null && isMember(v) ? OLD : FOREIGN;
  }
  for (const f of KEY_FAMILIES) {
    const read = f.read(key);
    if (read !== null) return owned(read.owner, read.at);
    if (f.free(key) !== null) return OLD;
  }
  // The draft namespace is the drafts' alone (edit-mode.ts), so any other key
  // under it is a draft in an older spelling.
  return key.startsWith(PLACEMENT_DRAFT_NS) ? OLD : FOREIGN;
}

// What one chain prefix holds: its files, lowest first, and every placement
// its merged tree places, as configure members.
export interface Hold {
  readonly paths: readonly string[];
  readonly placed: ReadonlySet<string>;
}

// [LAW:types-are-the-program] What a load holds, by owner: every prefix of
// its chain. A key whose owner is not here belongs to a chain this load did
// not read, and the load says nothing about it.
export type Holds = ReadonlyMap<Owner, Hold>;

// Each prefix's merged tree, measured before unplaced placements are dropped:
// a placement whose segment this load does not declare has not ended. A
// prefix merges alike whatever sits above it (inheritedConfig), so the
// prefix through one file holds the same placements in every chain holding
// that file.
export function holdsOf(chain: Pick<LoadedChain, "base" | "layers">): Holds {
  const prefixes = [
    { paths: [] as readonly string[], config: chain.base },
    ...chain.layers.map((layer, i) => ({
      paths: chain.layers.slice(0, i + 1).map((l) => l.path),
      config: layer.config,
    })),
  ];
  return new Map(
    prefixes.map(({ paths, config }) => [
      chainOwner(paths),
      { paths, placed: placedIn(config) },
    ]),
  );
}

// Every (preset, id) a config's trees place, over every preset: a row can be
// shared, so a tree one preset renders can hold another's placement.
function placedIn(config: Pick<DslConfig, "presets" | "root">): Set<string> {
  return new Set(
    presetNames(config.presets).flatMap((preset) =>
      [...walkNodes(presetRoot(config, preset).node)].flatMap((n) =>
        n.kind === "segment"
          ? [CONFIGURING.mint({ preset, id: placementId(n) })]
          : [],
      ),
    ),
  );
}

// A literal prefix as a regex source.
function dots(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
