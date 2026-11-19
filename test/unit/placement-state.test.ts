// [LAW:one-source-of-truth] The placement a session key holds state for is
// read back off the keys edit chrome mints, so the two spellings are held
// together here: every key the chrome declares for a placement names a
// placement its config places, and nothing an author or a setting holds is
// read as a placement's.

import {
  placementHolding,
  placementsOf,
  type PlacementOwner,
} from "../../src/config/placement-state";
import {
  configureMember,
  EDIT_CONFIGURE_KEY,
  EDIT_MODE_KEY,
  PLACEMENT_DRAFT_NS,
} from "../../src/config/loader/edit-mode";
import { EDIT_LIVE_KEY } from "../../src/config/edit-chrome";
import { DISCLOSURE_CLOSED } from "../../src/config/disclosure";
import { sharedMenuStateKey } from "../../src/config/menu-keys";
import { MENU_NS, MENU_PAGE_NS } from "../../src/config/reserved-names";
import { parseAndValidate } from "../helpers/parse-and-validate";
import { placementsJudged } from "../../src/renderer/render-cache";
import { DroppedFileError } from "../../src/config/loader/diagnostics";
import type { ValidatedConfig } from "../../src/config/dsl-types";

// Names that need escaping: a preset with punctuation, an id with a `.`.
const SRC = (placesDotted: boolean): string => `{
  segments: {
    a: {
      template: 'a',
      settings: {
        x: { label: 'x', domain: 'bool', default: true },
        form: { label: 'form', domain: ['short', 'long'], default: 'short' },
      },
    },
    b: { template: 'b' },
  },
  presets: { 'wide-1': { root: { h: ['b', { seg: 'a', id: 'a2' }] } } },
  root: { h: [${placesDotted ? "{ seg: 'a', id: 'a.x-2' }, " : ""}'a', 'b'] },
}`;

// Every state key the config declares that edit chrome minted for a placement.
const placementKeys = (config: ValidatedConfig): string[] =>
  Object.values(config.variables).flatMap((v) =>
    v.kind === "state" &&
    [PLACEMENT_DRAFT_NS, `${MENU_NS}edit_`, `${MENU_PAGE_NS}${MENU_NS}edit_`].some(
      (ns) => v.key.startsWith(ns),
    )
      ? [v.key]
      : [],
  );

describe("the placement a session key holds state for", () => {
  const config = parseAndValidate("<placements>", SRC(true));
  const placements = placementsOf(config);
  const owner = (key: string, value = "x"): PlacementOwner | null =>
    placementHolding(key, value);

  test("every key edit chrome mints for a placement names one the config places", () => {
    const keys = placementKeys(config);
    // Drafts, ✚ libraries and their pages, configure lists: all of them.
    expect(keys.filter((k) => k.startsWith(PLACEMENT_DRAFT_NS)).length).toBeGreaterThan(0);
    expect(keys.filter((k) => k.startsWith(MENU_PAGE_NS)).length).toBeGreaterThan(0);
    expect(keys.filter((k) => k.includes("_configure_")).length).toBeGreaterThan(0);
    const unowned = keys.filter((k) => {
      const o = owner(k);
      return o === null || !placements.has(o);
    });
    expect(unowned).toEqual([]);
  });

  test("the configure key names its placement while open, and nothing closed", () => {
    for (const [preset, id] of [
      ["default", "a.x-2"],
      ["wide-1", "a2"],
    ] as const) {
      const o = owner(EDIT_CONFIGURE_KEY, configureMember(preset, id));
      expect(o !== null && placements.has(o)).toBe(true);
    }
    expect(owner(EDIT_CONFIGURE_KEY, DISCLOSURE_CLOSED)).toBeNull();
  });

  test("an author's menu, a setting and edit mode's own keys are no placement's", () => {
    for (const key of [
      EDIT_MODE_KEY,
      EDIT_LIVE_KEY,
      "theme",
      sharedMenuStateKey("candybar.pickers"),
      `${MENU_NS}pick.apply`,
      `${MENU_PAGE_NS}${MENU_NS}pick.apply`,
    ])
      expect(owner(key)).toBeNull();
  });

  test("a load that failed, warned or dropped an entry judges every placement standing", () => {
    const gone = owner(EDIT_CONFIGURE_KEY, configureMember("default", "gone"))!;
    const load = (over: object) =>
      placementsJudged({
        lastError: null,
        lastWarnings: [],
        state: { placements, dropped: [] },
        ...over,
      });
    expect(load({}).has(gone)).toBe(false);
    for (const unclean of [
      { lastError: "parse error" },
      { lastWarnings: ["a plugin's folder is missing"] },
      {
        state: {
          placements,
          dropped: [new DroppedFileError("/c.json5", [])],
        },
      },
    ])
      expect(load(unclean).has(gone)).toBe(true);
  });

  test("a placement a later config drops is no longer placed, in any of its keys", () => {
    // Its drafts spell the id as written, its menus escaped.
    const before = placementKeys(config).filter(
      (k) => k.includes(".a.x-2.") || k.includes("aZ00002exZ00002d2"),
    );
    expect(before.filter((k) => k.startsWith(PLACEMENT_DRAFT_NS)).length).toBeGreaterThan(0);
    expect(before.filter((k) => k.startsWith(MENU_NS)).length).toBeGreaterThan(0);
    const after = placementsOf(parseAndValidate("<dropped>", SRC(false)));
    expect(before.filter((k) => after.has(owner(k)!))).toEqual([]);
    expect(after.has(owner(EDIT_CONFIGURE_KEY, configureMember("default", "a.x-2"))!)).toBe(false);
    expect(after.has(owner(EDIT_CONFIGURE_KEY, configureMember("default", "a"))!)).toBe(true);
  });
});
