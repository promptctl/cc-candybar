// A setting's one parse of a stored spelling, the one fold over it — which
// answers the rung that decided — and the one sentence of a stale pick, for
// global and placement settings alike.

import {
  globalSettings,
  pickOf,
  placementFold,
  placementSetting,
  settingTable,
} from "../../src/config/setting-table";
import type { SettingVarDecl } from "../../src/config/dsl-types";
import {
  effectiveGlobal,
  notInstalledTheme,
  notPlacementTheme,
} from "../../src/themes/policy";
import { staleWarning } from "../../src/dsl/render";
import { synthesizeEditChrome } from "../../src/config/edit-chrome";
import { mergeWithDefault, parseDslConfig } from "../../src/config/dsl-loader";
import { EMPTY_DEFAULT, parseAndValidate } from "../helpers/parse-and-validate";

const LOOK = {
  hueShift: 0,
  chromaScale: 1,
  lightnessScale: 1,
  lightnessShift: 0,
};
const GLOBAL = globalSettings({
  styles: { none: LOOK, washed: { ...LOOK, chromaScale: 0.3 } },
  presets: { roomy: {} },
});

const placement = (
  setting: string,
  decl: SettingVarDecl["decl"],
  saved: SettingVarDecl["saved"],
) =>
  placementSetting(`edit.draft.v.${setting}`, {
    kind: "setting",
    key: `edit.draft.default.knob.${setting}`,
    preset: "default",
    id: "knob",
    setting,
    decl,
    saved,
  });

const N = placement(
  "n",
  { label: "N", domain: { min: 1, max: 5, step: 1 }, default: 2 },
  3,
);
const THEME = placement(
  "theme",
  { label: "Theme", domain: "theme", default: "bar" },
  "bar",
);

describe("the one parse of a stored spelling", () => {
  test("nothing stored is unset", () => {
    expect(pickOf(GLOBAL.style, null)).toEqual({ kind: "unset" });
    expect(pickOf(N, null)).toEqual({ kind: "unset" });
  });

  test("a spelling the domain holds is held, as its value", () => {
    expect(pickOf(GLOBAL.preset, "roomy")).toEqual({
      kind: "held",
      value: "roomy",
    });
    expect(pickOf(GLOBAL.padding, "4")).toEqual({ kind: "held", value: 4 });
    expect(pickOf(N, "5")).toEqual({ kind: "held", value: 5 });
    expect(pickOf(THEME, "bar")).toEqual({ kind: "held", value: "bar" });
    expect(pickOf(GLOBAL.theme, "nord")).toMatchObject({
      kind: "held",
      value: { kind: "decided", name: "nord" },
    });
  });

  // The floor preset resolves whether or not a config declares it, so the
  // preset row offers it and its parse holds it.
  test("the floor preset is held though no config declares it", () => {
    expect(pickOf(GLOBAL.preset, "default")).toEqual({
      kind: "held",
      value: "default",
    });
    expect(GLOBAL.preset.domain).toEqual({
      kind: "values",
      members: ["default", "roomy"],
    });
  });

  test("a spelling the domain does not hold is stale, keeping the spelling", () => {
    expect(pickOf(GLOBAL.style, "vapor")).toEqual({
      kind: "stale",
      raw: "vapor",
    });
    expect(pickOf(GLOBAL.theme, "dark")).toEqual({
      kind: "stale",
      raw: "dark",
    });
    expect(pickOf(GLOBAL.padding, "99")).toEqual({ kind: "stale", raw: "99" });
    expect(pickOf(N, "9")).toEqual({ kind: "stale", raw: "9" });
  });

  // A style is a config's own declaration: a name it inherits from Object's
  // prototype is none.
  test("an inherited name is no declared style", () => {
    expect(pickOf(GLOBAL.style, "constructor")).toEqual({
      kind: "stale",
      raw: "constructor",
    });
  });
});

describe("the fold answers the rung that decided", () => {
  test("a staged value decides over any pick, so a stale one decides nothing", () => {
    expect(effectiveGlobal(7, { kind: "stale", raw: "x" }, 2, 0)).toEqual({
      value: 7,
      by: { kind: "staged" },
    });
  });

  test("a held pick decides; a stale one would have, and falls beneath", () => {
    expect(
      effectiveGlobal(undefined, { kind: "held", value: 5 }, 2, 0),
    ).toEqual({ value: 5, by: { kind: "picked" } });
    expect(
      effectiveGlobal(undefined, { kind: "stale", raw: "x" }, 2, 0),
    ).toEqual({ value: 2, by: { kind: "stale", raw: "x" } });
    expect(effectiveGlobal(undefined, { kind: "unset" }, null, 0)).toEqual({
      value: 0,
      by: { kind: "beneath" },
    });
  });

  test("a placement wears its pick when held, else its saved value", () => {
    expect(placementFold(N, "4")).toEqual({
      value: 4,
      by: { kind: "picked" },
    });
    expect(placementFold(N, "9")).toEqual({
      value: 3,
      by: { kind: "stale", raw: "9" },
    });
    expect(placementFold(N, null)).toEqual({
      value: 3,
      by: { kind: "beneath" },
    });
  });
});

describe("the sentence of a stale pick", () => {
  const sentence = (...args: Parameters<typeof staleWarning>) =>
    staleWarning(...args).message;

  test("a closed domain names what the setting can hold", () => {
    expect(sentence({ setting: GLOBAL.style, stored: "vapor" }, "washed")).toBe(
      'setting "style": "vapor" is not one of "none", "washed", so the bar wears "washed" until the session picks again or saves',
    );
    expect(sentence({ setting: N, stored: "9" }, "3")).toBe(
      'placement "knob" setting "n": "9" is not an integer from 1 to 5, so the bar wears "3" until the session picks again or saves',
    );
  });

  test("a theme says it in the installed-theme wording, a retired name with its successor", () => {
    expect(sentence({ setting: GLOBAL.theme, stored: "dark" }, "nord")).toBe(
      'setting "theme": "dark" is not an installed theme — "dark" was retired; write "textual-dark", the same palette, so the bar wears "nord" until the session picks again or saves',
    );
    expect(sentence({ setting: GLOBAL.theme, stored: "nope" }, "nord")).toBe(
      `setting "theme": ${notInstalledTheme("nope")}, so the bar wears "nord" until the session picks again or saves`,
    );
  });

  test("a placement's theme also names the bar's own theme", () => {
    expect(sentence({ setting: THEME, stored: "nope" }, "bar")).toBe(
      `placement "knob" setting "theme": ${notPlacementTheme("nope")}, so the bar wears "bar" until the session picks again or saves`,
    );
  });

  test("the installed themes are listed capped, as every refusal lists values", () => {
    expect(notInstalledTheme("nope")).toMatch(
      /^"nope" is not an installed theme \(have: [^,]+, [^,]+, [^,]+ and \d+ more\)$/,
    );
  });
});

// A table is memoized per config object, so a pass that added settings to a
// config in place, after its table was built, would leave the table without
// them. Edit chrome is the pass that mints placement settings.
describe("a config's table holds every setting it has", () => {
  const SOURCE = `{
    segments: { knob: { template: "k", settings: { n: { label: "N", domain: { min: 1, max: 5 }, default: 2 } } } },
    root: { rows: { main: { h: ["knob"] } } },
  }`;

  test("edit chrome mints placement settings into a new config, never in place", () => {
    const before = mergeWithDefault(
      parseDslConfig("<table>", SOURCE),
      EMPTY_DEFAULT,
    );
    const variables = Object.keys(before.variables);
    expect(settingTable(before).placements).toEqual([]);
    const chromed = synthesizeEditChrome(before);
    expect(chromed).not.toBe(before);
    expect(Object.keys(before.variables)).toEqual(variables);
    expect(settingTable(before).placements).toEqual([]);
    expect(settingTable(chromed).placements.map((s) => [s.id, s.name])).toEqual(
      expect.arrayContaining([["knob", "n"]]),
    );
  });

  test("a loaded config's table holds its placements' settings", () => {
    const loaded = parseAndValidate("<table>", SOURCE);
    expect(settingTable(loaded).placements.map((s) => [s.id, s.name])).toEqual(
      expect.arrayContaining([["knob", "n"]]),
    );
  });
});
