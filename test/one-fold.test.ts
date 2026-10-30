// [LAW:behavior-not-structure] What a value reads is folded once, and a read
// lands on one declaration, because no declared name sits under another. The
// theorem is asserted on the names the store is declared from — the built
// config, synthesis included — and on configs that try to break it, which the
// load refuses naming both names.

import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import {
  mergeWithDefault,
  parseDslConfig,
  unauthored,
} from "../src/config/dsl-loader";
import { declaredVariables } from "../src/config/loader/refs";
import { ConfigError } from "../src/config/loader/diagnostics";
import type { DslConfig } from "../src/config/dsl-types";
import { PRESET_FLOOR } from "../src/config/presets";
import { buildNeededPrefixes } from "../src/daemon/render-payload";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { EMPTY_DEFAULT, parseAndValidate, validateConfig } from "./helpers/parse-and-validate";

const ALLOWED = new Set(listResolvablePaletteNames());

// Every pair of declared names one of which starts the other.
function nested(config: DslConfig): string[] {
  const names = new Set([...declaredVariables(config)].map(([n]) => n));
  return [...names].flatMap((name) => {
    const parts = name.split(".");
    return parts
      .slice(1)
      .map((_, i) => parts.slice(0, i + 1).join("."))
      .filter((outer) => names.has(outer))
      .map((outer) => `${outer} < ${name}`);
  });
}

const overDefault = (src: string): DslConfig =>
  parseAndValidate("<user>", src, ALLOWED, DEFAULT_DSL_CONFIG);

const MENU = `{{ menu "applyTheme" "theme ▸" "theme ▾" }}`;

describe("no declared name sits under another", () => {
  test("in the built bundled config, settings menu and edit chrome included", () => {
    const built = validateConfig(unauthored(DEFAULT_DSL_CONFIG));
    expect([...declaredVariables(built)].length).toBeGreaterThan(600);
    expect(nested(built)).toEqual([]);
  });

  test("in a built user config that places a menu and declares a group", () => {
    const built = overDefault(`{
      actions: { applyTheme: { set: "theme", from: "themes" } },
      segments: {
        themeMenu: { template: '${MENU}' },
        body: { template: "body" },
      },
      root: { v: [
        { h: ["themeMenu"] },
        { kind: "group", name: "details", label: "details", children: [{ kind: "segment", name: "body" }] },
      ] },
    }`);
    expect(Object.keys(built.variables)).toContain(
      "menus.themeMenu.applyTheme",
    );
    expect(Object.keys(built.variables)).toContain("groups.details");
    expect(nested(built)).toEqual([]);
  });

  test("an accordion key that collapses to a placement id is refused, naming both", () => {
    expect(() =>
      overDefault(`{
        actions: {
          applyTheme: { set: "theme", from: "themes" },
          applyStyle: { set: "style", from: "styles" },
        },
        segments: {
          themeMenu: { template: '${MENU}' },
          other: { template: '{{ menu "applyStyle" "style" (dict "key" "themeMenu") }}' },
        },
        root: { h: ["themeMenu", "other"] },
      }`),
    ).toThrow(
      /"menus\.themeMenu\.applyTheme" is declared under the variable "menus\.themeMenu"/,
    );
  });

  test("a user segment named like a settings accordion key, holding a menu, is refused", () => {
    expect(() =>
      overDefault(`{
        actions: { applyTheme: { set: "theme", from: "themes" } },
        segments: { candybar_gearPickers: { template: '${MENU}' } },
        root: { h: ["candybar_gearPickers"] },
      }`),
    ).toThrow(
      /"menus\.candybar_gearPickers\.applyTheme" is declared under the variable "menus\.candybar_gearPickers"/,
    );
  });

  test("a user variable `menus` beside a placed menu is refused", () => {
    expect(() =>
      overDefault(`{
        variables: { menus: { kind: "literal", value: "x" } },
        actions: { applyTheme: { set: "theme", from: "themes" } },
        segments: { themeMenu: { template: '${MENU}' } },
        root: { h: ["themeMenu"] },
      }`),
    ).toThrow(
      /"menus\.themeMenu\.applyTheme" is declared under the variable "menus"/,
    );
  });

  test("a user variable above a name the settings menu declares is refused at the user's own name", () => {
    let thrown: unknown;
    try {
      overDefault(
        `{ variables: { theme: { kind: "state", key: "theme", default: "nord" } } }`,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).issues).toEqual([
      expect.objectContaining({
        path: "variables.theme",
        message: expect.stringMatching(
          /"theme\.effective" is declared under the variable "theme" .* "theme\.effective" is declared outside this file .*, so rename "theme"\.$/,
        ),
      }),
    ]);
  });

  test("a user's own nested names are refused, naming both", () => {
    expect(() =>
      overDefault(`{
        variables: {
          status: { kind: "literal", value: "x" },
          "status.home": { kind: "literal", value: "y" },
        },
      }`),
    ).toThrow(
      /"status\.home" is declared under the variable "status" .* Rename one so neither name starts with the other\./,
    );
    expect(() =>
      overDefault(`{
        segments: { s: { template: "s", vars: {
          a: { kind: "literal", value: "x" },
          "a.b": { kind: "literal", value: "y" },
        } } },
      }`),
    ).toThrow(/"s\.a\.b" is declared under the variable "s\.a"/);
  });

  test("a name under the page cursors' namespace is refused by its reservation", () => {
    expect(() =>
      overDefault(
        `{ variables: { "menupages.x": { kind: "literal", value: "x" } } }`,
      ),
    ).toThrow(/"menupages\.x" is in the reserved "menupages\." namespace/);
  });
});

describe("the input closure follows every edge the draw does", () => {
  // The config as merged, before synthesis: the settings menu binds an action
  // by a name it computes, which reaches every action's text, so a negative
  // control needs a bar without it.
  const closureOf = (src: string): ReadonlySet<string> =>
    buildNeededPrefixes(
      mergeWithDefault(parseDslConfig("<user>", src, ALLOWED), EMPTY_DEFAULT),
      PRESET_FLOOR,
    );

  test("a copy text's read of an input no segment reads", () => {
    const placing = (template: string): ReadonlySet<string> =>
      closureOf(`{
        variables: { dir: { kind: "input", path: "fixture.dir", default: "" } },
        actions: { cp: { copy: "{{ .dir }}" } },
        segments: { s: { template: '${template}' }, t: { template: '{{ action "cp" "copy" }}' } },
        root: { h: ["s"] },
      }`);
    expect(placing(`{{ action "cp" "copy" }}`).has("fixture.dir")).toBe(true);
    expect(placing("plain").has("fixture.dir")).toBe(false);
  });

  test("a source's cache key's read of an input no segment reads", () => {
    const needed = closureOf(`{
      variables: {
        dir: { kind: "input", path: "fixture.dir", default: "" },
        stamp: { kind: "shell", command: "echo hi", parse: { text: true }, cache: { key: "{{ .dir }}" } },
      },
      segments: { s: { template: "{{ .stamp }}" } },
      root: { h: ["s"] },
    }`);
    expect(needed.has("fixture.dir")).toBe(true);
  });
  test("and not one no placed template reaches", () => {
    const needed = closureOf(`{
      variables: {
        dir: { kind: "input", path: "fixture.dir", default: "" },
        stamp: { kind: "shell", command: "echo hi", parse: { text: true }, cache: { key: "{{ .dir }}" } },
      },
      segments: { s: { template: "plain" }, t: { template: "{{ .stamp }}" } },
      root: { h: ["s"] },
    }`);
    expect(needed.has("fixture.dir")).toBe(false);
  });
});
