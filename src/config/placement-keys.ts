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
// [LAW:single-enforcer] Each family is one template, and its minters and
// readers are all generated from it. Every reading is checked by minting it
// again, so a text the template would not write reads as nothing.

import { escapedIdent, unescapedIdent } from "./ident.js";
import { menuPageKey } from "./menu-keys.js";
import { MENU_NS, MENU_PAGE_NS } from "./reserved-names.js";
import { EDIT_CONFIGURE_KEY, PLACEMENT_DRAFT_NS } from "./loader/edit-mode.js";
import { placementIds, type DslConfig } from "./dsl-types.js";
import { presetNames, presetRoot } from "./presets.js";
import { digestOf } from "../utils/plain.js";
import { escapeRegExp } from "../utils/regex.js";

// [LAW:types-are-the-program] What owns a placement's session state: a chain
// prefix, spelled `o` and 16 hex digits of the digest of its files, lowest
// first. The bundled default alone is the empty chain.
export type Owner = string & { readonly __placementOwner: unique symbol };

export function chainOwner(paths: readonly string[]): Owner {
  return `o${digestOf([...paths]).slice(0, 16)}` as Owner;
}

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

// ─── Templates ──────────────────────────────────────────────────────────────

// The fields a template spells, each by the pattern its spelling matches: a
// name is `escapedIdent`'s letters and digits, never a `.`, `_` or `:`, so
// each field is told apart from its neighbours.
const FIELDS = {
  preset: "[A-Za-z0-9]+",
  id: "[A-Za-z0-9]+",
  setting: "[^.]+",
  relation: "before|after",
} as const;
type FieldName = keyof typeof FIELDS;
type Fields = Partial<Record<FieldName, string>>;

interface FieldPart {
  readonly field: FieldName;
}
// Where the owner goes in the owned form, and the separator after it. The
// owner-free form omits both.
interface OwnerPart {
  readonly ownerThen: string;
}
type Part = string | FieldPart | OwnerPart;

const PRESET: FieldPart = { field: "preset" };
const ID: FieldPart = { field: "id" };
const SETTING: FieldPart = { field: "setting" };
const RELATION: FieldPart = { field: "relation" };
const owner = (then: string): OwnerPart => ({ ownerThen: then });

// A template: its literal text, and the fields and owner it spells.
function spelled(
  strings: TemplateStringsArray,
  ...parts: Array<string | FieldPart | OwnerPart>
): readonly Part[] {
  return strings.flatMap((text, i) =>
    i < parts.length ? [text, parts[i]!] : [text],
  );
}

const render = (
  template: readonly Part[],
  fields: Fields,
  by: Owner | null,
): string =>
  template
    .map((part) =>
      typeof part === "string"
        ? part
        : "field" in part
          ? fields[part.field]!
          : by === null
            ? ""
            : by + part.ownerThen,
    )
    .join("");

// The template as a regex: a field's first appearance captures it by name and
// each later one must repeat it.
function pattern(template: readonly Part[], owned: boolean): RegExp {
  const seen = new Set<FieldName>();
  const source = template
    .map((part) => {
      if (typeof part === "string") return escapeRegExp(part);
      if ("ownerThen" in part)
        return owned
          ? `(?<owner>o[0-9a-f]{16})${escapeRegExp(part.ownerThen)}`
          : "";
      if (seen.has(part.field)) return `\\k<${part.field}>`;
      seen.add(part.field);
      return `(?<${part.field}>${FIELDS[part.field]})`;
    })
    .join("");
  return new RegExp(`^${source}$`);
}

// [LAW:one-type-per-behavior] One family: how its owner-free form and its
// owned form are spelled, and how each reads back.
export interface Family<A extends Placement> {
  // The owner-free form: what the config, the compile and the links name.
  readonly mint: (at: A) => string;
  // The owned form of an owner-free text, or null when the text is not this
  // family's owner-free form.
  readonly own: (text: string, by: Owner) => string | null;
  // The placement an owner-free text names, or null.
  readonly free: (text: string) => A | null;
  // The owner and placement an owned text names, or null.
  readonly read: (
    text: string,
  ) => { readonly owner: Owner; readonly at: A } | null;
  // The owner-free form of an owned text, or null.
  readonly unown: (text: string) => string | null;
}

function family<A extends Placement>(
  template: readonly Part[],
  // A placement's fields as the template spells them, and back.
  fieldsOf: (at: A) => Fields,
  atOf: (fields: Fields) => A | null,
): Family<A> {
  const freeForm = pattern(template, false);
  const ownedForm = pattern(template, true);
  const mint = (at: A): string => render(template, fieldsOf(at), null);
  const parse = (re: RegExp, text: string) => {
    const groups = re.exec(text)?.groups;
    const at = groups === undefined ? null : atOf(groups);
    return at === null
      ? null
      : { at, by: (groups!.owner ?? null) as Owner | null };
  };
  const free = (text: string): A | null => {
    const got = parse(freeForm, text);
    return got !== null && mint(got.at) === text ? got.at : null;
  };
  const read = (text: string) => {
    const got = parse(ownedForm, text);
    return got !== null &&
      got.by !== null &&
      render(template, fieldsOf(got.at), got.by) === text
      ? { owner: got.by, at: got.at }
      : null;
  };
  return {
    mint,
    free,
    own: (text, by) => {
      const at = free(text);
      return at === null ? null : render(template, fieldsOf(at), by);
    },
    read,
    unown: (text) => {
      const got = read(text);
      return got === null ? null : mint(got.at);
    },
  };
}

// A family's page cursors: `menuPageKey` of either of its forms.
function paged<A extends Placement>(menu: Family<A>): Family<A> {
  const under = (text: string): string | null =>
    text.startsWith(MENU_PAGE_NS) ? text.slice(MENU_PAGE_NS.length) : null;
  return {
    mint: (at) => menuPageKey(menu.mint(at)),
    own: (text, by) => {
      const inner = under(text);
      const owned = inner === null ? null : menu.own(inner, by);
      return owned === null ? null : menuPageKey(owned);
    },
    free: (text) => {
      const inner = under(text);
      return inner === null ? null : menu.free(inner);
    },
    read: (text) => {
      const inner = under(text);
      return inner === null ? null : menu.read(inner);
    },
    unown: (text) => {
      const inner = under(text);
      const free = inner === null ? null : menu.unown(inner);
      return free === null ? null : menuPageKey(free);
    },
  };
}

const placementFields = ({ preset, id }: Placement): Fields => ({
  preset: escapedIdent(preset),
  id: escapedIdent(id),
});

const placementOf = ({ preset = "", id = "" }: Fields): Placement | null => {
  const p = unescapedIdent(preset);
  const i = unescapedIdent(id);
  return p === null || i === null ? null : { preset: p, id: i };
};

// [LAW:one-source-of-truth] THE session key an unsaved value of one
// placement's setting lives at: the preset (an id is unique only in the tree
// one preset renders), the id, and the setting. A setting name is an
// identifier and both names are escaped, so the key names one value.
export const DRAFTS: Family<Draft> = family<Draft>(
  spelled`${PLACEMENT_DRAFT_NS}${owner(".")}${PRESET}.${ID}.${SETTING}`,
  (at) => ({ ...placementFields(at), setting: at.setting }),
  (f) => {
    const at = placementOf(f);
    return at === null ? null : { ...at, setting: f.setting! };
  },
);

// The shared `{{ menu }}` key one placement's setting pickers accordion on:
// the shared menu key of `edit.<preset>.configure.<id>` (menu-keys.ts).
export const CONFIGURE_LISTS: Family<Placement> = family<Placement>(
  spelled`${MENU_NS}edit_${owner("_")}${PRESET}_configure_${ID}`,
  placementFields,
  placementOf,
);

// The open state of the ✚ library beside one placement: the menu key its
// `{{ menu }}` derives from the gap's host segment and insert action
// (insertGap, menu-keys.ts).
export const LIBRARIES: Family<Gap> = family<Gap>(
  spelled`${MENU_NS}edit_${owner("_")}${PRESET}_insertSeg_${RELATION}_${ID}.edit_${PRESET}_insert_${RELATION}_${ID}`,
  (at) => ({ ...placementFields(at), relation: at.relation }),
  (f) => {
    const at = placementOf(f);
    return at === null || (f.relation !== "before" && f.relation !== "after")
      ? null
      : { ...at, relation: f.relation };
  },
);

// [LAW:one-source-of-truth] The value of the configure key that configures
// one placement: an id is unique only within one preset's tree, so the
// preset rides with it, and both are escaped, so `:` splits them exactly.
export const CONFIGURING: Family<Placement> = family<Placement>(
  spelled`${owner(":")}${PRESET}:${ID}`,
  placementFields,
  placementOf,
);

export const placementDraftKey = (
  preset: string,
  id: string,
  setting: string,
): string => DRAFTS.mint({ preset, id, setting });

export const configureMember = (preset: string, id: string): string =>
  CONFIGURING.mint({ preset, id });

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
  const fields = placementFields({ preset, id: anchor });
  const gap = `${relation}.${fields.id!}`;
  return {
    apply: `edit.${fields.preset!}.insert.${gap}`,
    host: `edit.${fields.preset!}.insertSeg.${gap}`,
    stateKey: LIBRARIES.mint({ preset, id: anchor, relation }),
  };
}

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
// no family's. `by` is asked only for a family's key: a click naming no
// session that has rendered has no owner, and writes none of these.
export function ownedKey(key: string, by: () => Owner): string {
  const f = KEY_FAMILIES.find((family) => family.free(key) !== null);
  return f === undefined ? key : f.own(key, by())!;
}

// The value `key` stores for `value`: a configure member is stored owned;
// every other value as it is.
export function ownedValue(
  key: string,
  value: string,
  by: () => Owner,
): string {
  return isOwnerFreeValue(key, value) ? CONFIGURING.own(value, by())! : value;
}

// What a stored value of `key` reads as under `by`: a configure member `by`
// holds, owner-free; a member another owner holds, or one in a form naming
// no owner, configures nothing here (null: the key's default).
export function freeValue(
  key: string,
  value: string | null,
  by: () => Owner,
): string | null {
  if (key !== EDIT_CONFIGURE_KEY || value === null || !isMember(value))
    return value;
  const read = CONFIGURING.read(value);
  return read !== null && read.owner === by()
    ? CONFIGURING.mint(read.at)
    : null;
}

// [LAW:one-source-of-truth] A stored (key, value) as the config names it, its
// owner dropped: what a config's gate admits or refuses, since the gate is
// derived from the shared compile, which names no owner.
export function ownerFree(
  key: string,
  value: string,
): { readonly key: string; readonly value: string } {
  return {
    key: KEY_FAMILIES.map((f) => f.unown(key)).find((k) => k !== null) ?? key,
    value:
      key === EDIT_CONFIGURE_KEY ? (CONFIGURING.unown(value) ?? value) : value,
  };
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

// A draft as the store holds it, owned: the settings history steps it.
export const isDraftKey = (key: string): boolean => DRAFTS.read(key) !== null;

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

const ownedBy = (by: Owner, at: Placement): Classified => ({
  kind: "owned",
  owner: by,
  member: CONFIGURING.mint(at),
});

// `value` is read only for the configure key, whose value is the family.
export function classify(key: string, value: () => string | null): Classified {
  if (key === EDIT_CONFIGURE_KEY) {
    const v = value();
    const read = v === null ? null : CONFIGURING.read(v);
    if (read !== null) return ownedBy(read.owner, read.at);
    return v !== null && isMember(v) ? OLD : FOREIGN;
  }
  for (const f of KEY_FAMILIES) {
    const read = f.read(key);
    if (read !== null) return ownedBy(read.owner, read.at);
    if (f.free(key) !== null) return OLD;
  }
  // The draft namespace is the drafts' alone (edit-mode.ts), so any other key
  // under it is a draft in an older spelling.
  return key.startsWith(PLACEMENT_DRAFT_NS) ? OLD : FOREIGN;
}

// What one chain prefix holds: its files, lowest first, and every placement
// its trees place, as configure members.
export interface Hold {
  readonly paths: readonly string[];
  readonly placed: ReadonlySet<string>;
}

// [LAW:types-are-the-program] What a load holds, by owner: every prefix of
// its chain. A key whose owner is not here belongs to a chain this load did
// not read, and the load says nothing about it.
export type Holds = ReadonlyMap<Owner, Hold>;

type Trees = Pick<DslConfig, "presets" | "root">;

// Each prefix's trees as it renders them, every insert cell its files write
// placed (the loader's `placed`): a placement an insert cell adds has not
// ended, and one whose segment the load does not declare has not either. A
// prefix merges alike whatever sits above it (inheritedConfig), so the
// prefix through one file holds the same placements in every chain holding
// that file.
export function holdsOf(chain: {
  readonly base: Trees;
  readonly layers: ReadonlyArray<{
    readonly path: string;
    readonly placed: Trees;
  }>;
}): Holds {
  const prefixes = [
    { paths: [] as readonly string[], trees: chain.base },
    ...chain.layers.map((layer, i) => ({
      paths: chain.layers.slice(0, i + 1).map((l) => l.path),
      trees: layer.placed,
    })),
  ];
  return new Map(
    prefixes.map(({ paths, trees }) => [
      chainOwner(paths),
      { paths, placed: placedIn(trees) },
    ]),
  );
}

// Every (preset, id) a config's trees place, over every preset: a row can be
// shared, so a tree one preset renders can hold another's placement.
function placedIn(trees: Trees): Set<string> {
  return new Set(
    presetNames(trees.presets).flatMap((preset) =>
      placementIds(presetRoot(trees, preset).node).map((id) =>
        CONFIGURING.mint({ preset, id }),
      ),
    ),
  );
}
