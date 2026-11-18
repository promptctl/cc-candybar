// [LAW:verifiable-goals] Which placement a session key belongs to is read back
// by the code that mints it (src/config/edit-chrome.ts `placementOfKey`): every
// key edit chrome mints for a placement names that placement, no other key
// names one, and nothing a config mints belongs to a placement that config
// doesn't hold, so meeting the config it was minted from releases nothing.

import {
  configureListKey,
  insertGap,
  placementDraftKey,
  placementOfKey,
  placementsOf,
} from "../src/config/edit-chrome";
import {
  configureMember,
  EDIT_CONFIGURE_KEY,
} from "../src/config/loader/edit-mode";
import { escapedIdent, unescapedIdent } from "../src/config/ident";
import { menuPageKey } from "../src/config/menu-keys";
import { settingsOf, type DslConfig } from "../src/config/dsl-types";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import { parseAndPlace } from "./helpers/parse-and-validate";

const PRESET = "2 col";
const ID = "x.y_Zé";
// `ident` spells this id as it spells ID; edit chrome must not.
const TWIN = "x.y-Zé";

// One segment with a setting, placed twice under each of two presets, ids
// spelled to break any collapse: punctuation, the escape letter, a non-ASCII
// letter, and a space in a preset's name.
const SRC = `{
  segments: {
    vcs: {
      template: 'v',
      settings: { detail: { label: 'detail', domain: 'bool', default: false } },
    },
  },
  presets: { '${PRESET}': { root: { h: [{ seg: 'vcs', id: '${ID}' }, { seg: 'vcs', id: '${TWIN}' }] } } },
  root: { h: [{ seg: 'vcs', id: '${ID}' }, { seg: 'vcs', id: '${TWIN}' }] },
}`;

// Every key edit chrome mints for one placement, from the minters themselves.
function mintedFor(
  config: DslConfig,
  preset: string,
  id: string,
): readonly string[] {
  const gaps = (["before", "after"] as const).flatMap((relation) => {
    const { stateKey } = insertGap(preset, id, relation);
    return [stateKey, menuPageKey(stateKey)];
  });
  const list = configureListKey(preset, id);
  const drafts = Object.keys(settingsOf(config.segments["vcs"]!)).map(
    (setting) => placementDraftKey(escapedIdent(preset), id, setting),
  );
  return [...gaps, list, menuPageKey(list), ...drafts];
}

// Every session key a loaded config declares a state variable over.
const declaredKeys = (config: DslConfig): readonly string[] =>
  Object.values(config.variables).flatMap((v) =>
    v.kind === "state" ? [v.key] : [],
  );

describe("a placement's keys read back as that placement", () => {
  const { config } = parseAndPlace("<config>", SRC);
  const placements = [PRESET, "default"].flatMap((preset) =>
    [ID, TWIN].map((id) => ({ preset, id })),
  );
  const owner = new Map(
    placements.flatMap(({ preset, id }) =>
      mintedFor(config, preset, id).map(
        (key) => [key, configureMember(preset, id)] as const,
      ),
    ),
  );

  test("every key minted for a placement names it", () => {
    for (const [key, member] of owner)
      expect([key, placementOfKey(key, "open")]).toEqual([key, member]);
  });

  test("the configure key names the placement its value configures", () => {
    for (const { preset, id } of placements) {
      const member = configureMember(preset, id);
      expect(placementOfKey(EDIT_CONFIGURE_KEY, member)).toBe(member);
    }
    expect(placementOfKey(EDIT_CONFIGURE_KEY, DISCLOSURE_CLOSED)).toBeNull();
  });

  test("the config declares the keys it mints, and every other key it declares names no placement", () => {
    const declared = declaredKeys(config);
    // The `after` gaps, the configure lists and the drafts are declared for
    // every placement; a `before` gap only for the first of a row.
    for (const key of owner.keys())
      if (!key.includes("before")) expect(declared).toContain(key);
    for (const key of declared)
      expect([key, placementOfKey(key, "open")]).toEqual([
        key,
        owner.get(key) ?? null,
      ]);
  });

  test("a key spelled in a way no minter spells it names no placement", () => {
    const gap = insertGap(PRESET, ID, "after").stateKey;
    const draft = placementDraftKey(escapedIdent(PRESET), ID, "detail");
    for (const key of [
      // `A` written as an escape, which escapedIdent keeps as itself.
      gap.replace(escapedIdent(PRESET), "Z000041"),
      gap.replace("after", "beside"),
      `${gap}.x`,
      `menupages.${gap}x`,
      draft.replace(escapedIdent(PRESET), "2 col"),
      "edit.draft.vcs",
      "menus.edit",
      "theme",
    ])
      expect([key, placementOfKey(key, "open")]).toEqual([key, null]);
    expect(placementOfKey(EDIT_CONFIGURE_KEY, `2 col:${ID}`)).toBeNull();
    expect(placementOfKey(EDIT_CONFIGURE_KEY, `Zffffff:${ID}`)).toBeNull();
  });
});

describe("nothing a config mints is released over that same config", () => {
  test.each([
    ["a config of its own", parseAndPlace("<config>", SRC)],
    [
      "the bundled default",
      parseAndPlace("<config>", "{}", undefined, DEFAULT_DSL_CONFIG),
    ],
  ])("%s holds every placement its keys name", (_label, { config, placed }) => {
    const held = placementsOf(placed);
    const members = declaredKeys(config).flatMap((key) => {
      const member = placementOfKey(key, "open");
      return member === null ? [] : [member];
    });
    expect(members.length).toBeGreaterThan(0);
    for (const member of members)
      expect([member, held.holds(member)]).toEqual([member, true]);
  });

  test("a placement the config doesn't hold is not held", () => {
    const held = placementsOf(parseAndPlace("<config>", SRC).placed);
    expect(held.holds(configureMember(PRESET, "gone"))).toBe(false);
    expect(held.holds(configureMember("other", ID))).toBe(false);
  });
});

describe("unescapedIdent inverts escapedIdent", () => {
  test.each([ID, TWIN, PRESET, "Z", "", "😀", "a\u0000b", "plain9"])(
    "%j round-trips",
    (name) => {
      expect(unescapedIdent(escapedIdent(name))).toBe(name);
    },
  );

  test.each(["Z000041", "Zffffff", "Z00", "a_b", "Zz00041"])(
    "%j is no spelling escapedIdent makes",
    (spelled) => {
      expect(unescapedIdent(spelled)).toBeNull();
    },
  );
});
