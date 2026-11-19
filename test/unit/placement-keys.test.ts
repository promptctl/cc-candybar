// [LAW:verifiable-goals] The spelling of a placement's session keys: every
// family reads back what it minted, in both forms, under any name; a key no
// family spells is left alone; a family's key naming no owner is one a load
// releases; and the store holds none of them without an owner.

import {
  CONFIGURE_LISTS,
  CONFIGURING,
  DRAFTS,
  LIBRARIES,
  chainOwner,
  classify,
  freeValue,
  insertGap,
  isOwnerFree,
  ownerFree,
  ownedKey,
  ownedValue,
  type Family,
  type Placement,
} from "../../src/config/placement-keys";
import {
  menuPageKey,
  menuStateKey,
  sharedMenuStateKey,
} from "../../src/config/menu-keys";
import { escapedIdent } from "../../src/config/ident";
import {
  EDIT_CONFIGURE_KEY,
  EDIT_MODE_KEY,
} from "../../src/config/loader/edit-mode";
import { SessionState } from "../../src/renderer/session-state";
import { ownedStore, releaseEnded } from "../../src/renderer/owned-store";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";

const A = chainOwner(["/home/u/.config/cc-candybar/config.json5"]);
const B = chainOwner([
  "/home/u/.config/cc-candybar/config.json5",
  "/p/.cc-candybar.json5",
]);
const S1 = sessionIdOf("s1");
const S2 = sessionIdOf("s2");

// Names an escape must keep whole and apart: a newline, punctuation `ident`
// folds, the escape marker itself, and letters beyond ASCII.
const NAMES = ["vcs", "a\nb", "git-2", "git_2", "Z", "é", "😀", "x.y:z"];
const PLACEMENTS: Placement[] = NAMES.flatMap((id) =>
  ["default", "my-preset"].map((preset) => ({ preset, id })),
);

const roundTrip = <P extends Placement>(f: Family<P>, at: P): void => {
  const free = f.mint(at);
  expect(f.free(free)).toEqual(at);
  const owned = f.own(free, A)!;
  expect(f.read(owned)).toEqual({ owner: A, at });
  // Neither form reads as the other.
  expect(f.read(free)).toBeNull();
  expect(f.free(owned)).toBeNull();
};

describe("every family reads back what it minted", () => {
  test.each(PLACEMENTS)("%o", (at) => {
    roundTrip(DRAFTS, { ...at, setting: "detail" });
    roundTrip(CONFIGURE_LISTS, at);
    roundTrip(LIBRARIES, { ...at, relation: "before" as const });
    roundTrip(LIBRARIES, { ...at, relation: "after" as const });
    roundTrip(CONFIGURING, at);
  });

  test("distinct placements spell distinct keys in every family", () => {
    const keys = PLACEMENTS.flatMap((at) => [
      DRAFTS.own(DRAFTS.mint({ ...at, setting: "detail" }), A),
      CONFIGURE_LISTS.own(CONFIGURE_LISTS.mint(at), A),
      LIBRARIES.own(LIBRARIES.mint({ ...at, relation: "after" }), A),
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a page cursor owns as its menu does", () => {
    const list = CONFIGURE_LISTS.mint({ preset: "default", id: "vcs" });
    const owned = ownedKey(menuPageKey(list), () => A);
    expect(owned).toBe(menuPageKey(CONFIGURE_LISTS.own(list, A)!));
    expect(classify(owned, () => null)).toEqual({
      kind: "owned",
      owner: A,
      member: CONFIGURING.mint({ preset: "default", id: "vcs" }),
    });
  });

  test("a text the minter would not write reads as no family's", () => {
    // A library whose tail names another placement than its head.
    const head = LIBRARIES.mint({
      preset: "default",
      id: "vcs",
      relation: "after",
    });
    const forged = head.replace(/_vcs$/, "_git");
    expect(forged).not.toBe(head);
    expect(LIBRARIES.free(forged)).toBeNull();
    // An escape that spells no character.
    expect(DRAFTS.free("edit.draft.default.vcsZ999999.detail")).toBeNull();
    expect(CONFIGURING.read(`${A}:default:vcsZ0`)).toBeNull();
  });
});

describe("what a release reads a stored key as", () => {
  test.each([
    ["an author's menu key", "menus.vcs.apply", null],
    ["edit mode", EDIT_MODE_KEY, null],
    ["the configure key, closed", EDIT_CONFIGURE_KEY, "closed"],
    ["a theme pick", "theme", null],
  ])("%s is no family's", (_label, key, value) => {
    expect(classify(key, () => value)).toEqual({ kind: "foreign" });
    expect(isOwnerFree(key)).toBe(false);
  });

  test.each([
    [
      "an owner-free draft",
      DRAFTS.mint({ preset: "default", id: "vcs", setting: "detail" }),
      null,
    ],
    ["a draft spelled before presets", "edit.draft.vcs.detail", null],
    [
      "an owner-free list",
      CONFIGURE_LISTS.mint({ preset: "default", id: "vcs" }),
      null,
    ],
    [
      "an owner-free library",
      LIBRARIES.mint({ preset: "default", id: "vcs", relation: "before" }),
      null,
    ],
    [
      "an owner-free configure member",
      EDIT_CONFIGURE_KEY,
      CONFIGURING.mint({ preset: "default", id: "vcs" }),
    ],
  ])("%s names no owner, so every load releases it", (_label, key, value) => {
    expect(classify(key, () => value)).toEqual({ kind: "old" });
  });

  test("a configure member another owner holds configures nothing here", () => {
    const member = CONFIGURING.mint({ preset: "default", id: "vcs" });
    const stored = ownedValue(EDIT_CONFIGURE_KEY, member, () => A);
    expect(freeValue(EDIT_CONFIGURE_KEY, stored, () => A)).toBe(member);
    expect(freeValue(EDIT_CONFIGURE_KEY, stored, () => B)).toBeNull();
  });
});

describe("the store holds a placement's keys only with their owner", () => {
  const draft = DRAFTS.mint({
    preset: "default",
    id: "vcs",
    setting: "detail",
  });
  const member = CONFIGURING.mint({ preset: "default", id: "vcs" });

  test("an owner-free key is refused on get, set and setBatch", () => {
    const store = new SessionState();
    expect(() => store.get(S1, draft)).toThrow(
      /names a placement with no owner/,
    );
    expect(() => store.set(S1, draft, "true")).toThrow(/no owner/);
    expect(() => store.setBatch(S1, [{ key: draft, value: "true" }])).toThrow(
      /no owner/,
    );
    expect(() => store.set(S1, EDIT_CONFIGURE_KEY, member)).toThrow(/no owner/);
    expect(store.size()).toBe(0);
  });

  test("an owned view writes the owned form, and reads it back owner-free", () => {
    const store = new SessionState();
    const a = ownedStore(store, () => A);
    a.set(S1, draft, "true");
    a.set(S1, EDIT_CONFIGURE_KEY, member);
    expect(store.keys(S1)).toEqual([DRAFTS.own(draft, A), EDIT_CONFIGURE_KEY]);
    expect(a.get(S1, draft)).toBe("true");
    expect(a.get(S1, EDIT_CONFIGURE_KEY)).toBe(member);
    // Another chain's view sees none of it.
    const b = ownedStore(store, () => B);
    expect(b.get(S1, draft)).toBeNull();
    expect(b.get(S1, EDIT_CONFIGURE_KEY)).toBeNull();
  });
});

describe("a release", () => {
  const vcs = { preset: "default", id: "vcs" };
  const git = { preset: "default", id: "git" };
  const draftOf = (at: Placement) => DRAFTS.mint({ ...at, setting: "detail" });

  test("ends the keys of each placement an owner no longer places, in every session, and names each", () => {
    const store = new SessionState();
    const a = ownedStore(store, () => A);
    const b = ownedStore(store, () => B);
    for (const s of [S1, S2]) {
      a.set(s, draftOf(vcs), "true");
      a.set(s, draftOf(git), "true");
      b.set(s, draftOf(vcs), "true");
      store.set(s, "menus.vcs.apply", "open");
    }
    a.set(S1, EDIT_CONFIGURE_KEY, CONFIGURING.mint(vcs));
    // A's chain still places git and no longer vcs; B's chain is not this load's.
    const lines = releaseEnded(
      store,
      store.sessions(),
      new Map([
        [A, { paths: ["/u.json5"], placed: new Set([CONFIGURING.mint(git)]) }],
      ]),
      "load",
    );
    for (const s of [S1, S2]) {
      expect(a.get(s, draftOf(vcs))).toBeNull();
      expect(a.get(s, draftOf(git))).toBe("true");
      expect(b.get(s, draftOf(vcs))).toBe("true");
      expect(store.get(s, "menus.vcs.apply")).toBe("open");
    }
    expect(a.get(S1, EDIT_CONFIGURE_KEY)).toBeNull();
    expect(lines).toEqual([
      // Sessions in the store's order: the last written first released last.
      `placement-state released by=load session=${S2} owner=${A} chain=/u.json5 keys=${DRAFTS.own(draftOf(vcs), A)}`,
      `placement-state released by=load session=${S1} owner=${A} chain=/u.json5 keys=${DRAFTS.own(draftOf(vcs), A)},${EDIT_CONFIGURE_KEY}`,
    ]);
  });

  test("ends every key that names no owner, whatever the load holds", () => {
    const store = new SessionState({
      [S1]: {
        [draftOf(vcs)]: "true",
        "edit.draft.vcs.detail": "true",
        [EDIT_CONFIGURE_KEY]: CONFIGURING.mint(vcs),
        theme: "ocean",
      },
    });
    const lines = releaseEnded(store, store.sessions(), new Map(), "load");
    expect(store.keys(S1)).toEqual(["theme"]);
    expect(lines).toEqual([
      `placement-state released by=load session=${S1} owner=none chain=- keys=${draftOf(vcs)},edit.draft.vcs.detail,${EDIT_CONFIGURE_KEY}`,
    ]);
  });

  test("the bundled default alone is the empty chain", () => {
    const store = new SessionState();
    const d = chainOwner([]);
    ownedStore(store, () => d).set(S1, draftOf(vcs), "true");
    const lines = releaseEnded(
      store,
      [S1],
      new Map([[d, { paths: [], placed: new Set<string>() }]]),
      "load",
    );
    expect(lines).toEqual([
      `placement-state released by=load session=${S1} owner=${d} chain=<default> keys=${DRAFTS.own(draftOf(vcs), d)}`,
    ]);
  });

  test("a release that ends nothing says it ran", () => {
    const store = new SessionState();
    ownedStore(store, () => A).set(S1, draftOf(vcs), "true");
    const holds = new Map([
      [A, { paths: ["/u.json5"], placed: new Set([CONFIGURING.mint(vcs)]) }],
    ]);
    expect(releaseEnded(store, [S1], holds, "click")).toEqual([
      "placement-state released by=click sessions=1 keys=0",
    ]);
  });
});

describe("the families spell what the menus derive", () => {
  test.each(PLACEMENTS)("%o", (at) => {
    // The `{{ menu }}` the ✚ hangs derives its key from its host and action.
    const gap = insertGap(at.preset, at.id, "after");
    expect(LIBRARIES.mint({ ...at, relation: "after" })).toBe(
      menuStateKey(gap.host, gap.apply, undefined),
    );
    // The configure pickers accordion on a shared key.
    expect(CONFIGURE_LISTS.mint(at)).toBe(
      sharedMenuStateKey(
        `edit.${escapedIdent(at.preset)}.configure.${escapedIdent(at.id)}`,
      ),
    );
  });

  test("a stored key and value read back as the config names them", () => {
    const list = CONFIGURE_LISTS.mint({ preset: "default", id: "vcs" });
    const member = CONFIGURING.mint({ preset: "default", id: "vcs" });
    expect(ownerFree(menuPageKey(CONFIGURE_LISTS.own(list, A)!), "2")).toEqual({
      key: menuPageKey(list),
      value: "2",
    });
    expect(ownerFree(EDIT_CONFIGURE_KEY, CONFIGURING.own(member, A)!)).toEqual({
      key: EDIT_CONFIGURE_KEY,
      value: member,
    });
    expect(ownerFree("theme", "ocean")).toEqual({
      key: "theme",
      value: "ocean",
    });
  });
});
