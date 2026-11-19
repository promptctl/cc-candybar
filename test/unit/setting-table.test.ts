// A setting's one parse of a stored spelling, and the one sentence of a stale
// pick, for global and placement settings alike.

import {
  globalSettings,
  pickOf,
  placementSetting,
  placementValue,
  staleMessage,
} from "../../src/config/setting-table";
import type { SettingVarDecl } from "../../src/config/dsl-types";
import { notInstalledTheme } from "../../src/themes/policy";

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

  test("a placement wears its pick when held, else its saved value", () => {
    expect(placementValue(N, "4")).toBe(4);
    expect(placementValue(N, "9")).toBe(3);
    expect(placementValue(N, null)).toBe(3);
  });
});

describe("the sentence of a stale pick", () => {
  test("a closed domain names what the setting can hold", () => {
    expect(
      staleMessage({ setting: GLOBAL.style, stored: "vapor" }, "washed"),
    ).toBe(
      'setting "style": "vapor" is not one of "none", "washed", so the bar wears "washed" (the pick stays stored)',
    );
    expect(staleMessage({ setting: N, stored: "9" }, "3")).toBe(
      'placement "knob" setting "n": "9" is not an integer from 1 to 5, so the bar wears "3" (the pick stays stored)',
    );
  });

  test("a theme says it in the installed-theme wording, a retired name with its successor", () => {
    expect(
      staleMessage({ setting: GLOBAL.theme, stored: "dark" }, "nord"),
    ).toBe(
      'setting "theme": "dark" is not an installed theme — "dark" was retired; write "textual-dark", the same palette, so the bar wears "nord" (the pick stays stored)',
    );
    expect(
      staleMessage({ setting: GLOBAL.theme, stored: "nope" }, "nord"),
    ).toBe(
      `setting "theme": ${notInstalledTheme("nope")}, so the bar wears "nord" (the pick stays stored)`,
    );
  });

  test("a placement's theme also names the bar's own theme", () => {
    expect(staleMessage({ setting: THEME, stored: "nope" }, "bar")).toBe(
      `placement "knob" setting "theme": ${notInstalledTheme("nope")}, and not "bar" (the bar's own theme), so the bar wears "bar" (the pick stays stored)`,
    );
  });
});
