// [LAW:one-source-of-truth] What a config declares of edit chrome's session
// state is the record a session's placement state is judged against. Held
// here against a second record nothing in it reads: the click gate, which
// lists every key a click on that config can write. Every key the gate
// admits stands, and every key a removed placement's chrome gave the gate is
// let go, whichever family it is in.

import {
  declaredStateOf,
  EVERY_KEY_STANDS,
} from "../../src/config/declared-state";
import {
  configureMember,
  EDIT_CONFIGURE_KEY,
} from "../../src/config/loader/edit-mode";
import { DISCLOSURE_CLOSED } from "../../src/config/disclosure";
import { sharedMenuStateKey } from "../../src/config/menu-keys";
import { DroppedFileError } from "../../src/config/loader/diagnostics";
import { stateJudged } from "../../src/renderer/render-cache";
import { parseAndValidate } from "../helpers/parse-and-validate";
import { stateGate } from "../helpers/gates";
import type { DroppedPlugin } from "../../src/config/loader/plugins";

// Names that need escaping: a preset with punctuation, an id with a `.`, and
// settings of both control kinds, inline and listed.
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

const DROPPED_PLUGIN: DroppedPlugin = {
  path: "/p/deploy/plugin.json5",
  scope: "plugins",
  name: undefined,
  reason: "ENOENT",
};

const placed = parseAndValidate("<placed>", SRC(true));
const removed = parseAndValidate("<removed>", SRC(false));
const writable = (config: typeof placed): readonly string[] =>
  stateGate(config).listKeys();

describe("the edit chrome state a config declares", () => {
  // The configure key's values are its own test's, below.
  test("every key a click on the config can write stands", () => {
    const declared = declaredStateOf(placed);
    const value = (k: string): string =>
      k === EDIT_CONFIGURE_KEY ? DISCLOSURE_CLOSED : "x";
    expect(
      writable(placed).filter((k) => !declared.holds(k, value(k))),
    ).toEqual([]);
  });

  test("every key the removed placement gave the gate is let go", () => {
    const left = new Set(writable(removed));
    const its = writable(placed).filter((k) => !left.has(k));
    // Its drafts, its configure lists and their pages, its `✚` libraries and
    // theirs: more than one family.
    expect(its.length).toBeGreaterThan(4);
    const declared = declaredStateOf(removed);
    expect(its.filter((k) => declared.holds(k, "x"))).toEqual([]);
  });

  test("the configure key holds a placement the config edits, or closed", () => {
    const before = declaredStateOf(placed);
    const after = declaredStateOf(removed);
    const dotted = configureMember("default", "a.x-2");
    expect(before.holds(EDIT_CONFIGURE_KEY, dotted)).toBe(true);
    expect(after.holds(EDIT_CONFIGURE_KEY, dotted)).toBe(false);
    for (const member of [
      configureMember("default", "a"),
      configureMember("wide-1", "a2"),
      DISCLOSURE_CLOSED,
    ])
      expect(after.holds(EDIT_CONFIGURE_KEY, member)).toBe(true);
  });

  test("an author's menu and a setting are no chrome's, declared or not", () => {
    const declared = declaredStateOf(removed);
    for (const key of [
      "theme",
      sharedMenuStateKey("candybar.pickers"),
      sharedMenuStateKey("pick.apply"),
      "menupages.menus.pick_apply",
    ])
      expect(declared.holds(key, "x")).toBe(true);
  });

  test("a load that failed, dropped a placement or stood in for a plugin judges every key standing", () => {
    const declared = declaredStateOf(removed);
    const load = (over: object) =>
      stateJudged({
        lastError: null,
        state: { declared, dropped: [], plugins: { dropped: [] } },
        ...over,
      });
    expect(load({})).toBe(declared);
    expect(load({ lastError: "parse error" })).toBe(EVERY_KEY_STANDS);
    expect(
      load({
        state: {
          declared,
          dropped: [new DroppedFileError("/c.json5", [])],
          plugins: { dropped: [] },
        },
      }),
    ).toBe(EVERY_KEY_STANDS);
    expect(
      load({
        state: { declared, dropped: [], plugins: { dropped: [DROPPED_PLUGIN] } },
      }),
    ).toBe(EVERY_KEY_STANDS);
  });
});
