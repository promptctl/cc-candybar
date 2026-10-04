// [LAW:verifiable-goals] brandon-config-dovk: a `set` on a setting's session
// key loads only when every value it can write is one the render resolves as a
// pick — otherwise the derived gate admits the value and the click does
// nothing. Run through the production cascade (DEFAULT_DSL_CONFIG), because
// the `styles` and `presets` domains are the merged config's.

import { parseAndValidate } from "./helpers/parse-and-validate";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { SESSION_KEY_TO_SETTING } from "../src/config/setting-projections";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const load = (action: string) =>
  parseAndValidate(
    "<set-domain>",
    `{ actions: { pick: ${action} } }`,
    undefined,
    DEFAULT_DSL_CONFIG,
  );

const THEME = listResolvablePaletteNames()[0]!;

describe("a set on a setting key is checked against the setting's domain", () => {
  it.each([
    ["{ set: 'endcaps', to: 'banana' }", /actions\.pick\.to: "banana" is outside the endcaps domain.*takes one of "powerline"/],
    ["{ set: 'padding', to: '99' }", /actions\.pick\.to: "99" .*an integer from 0 to 16/],
    ["{ set: 'padding', to: '3 ' }", /actions\.pick\.to: "3 "/],
    // The session holds an integer as String(n) writes it, nothing else.
    ["{ set: 'padding', to: '-0' }", /actions\.pick\.to: "-0"/],
    ["{ set: 'padding', to: '007' }", /actions\.pick\.to: "007"/],
    // A stepper's bad end is reported at the end that states it.
    ["{ set: 'padding', min: 0, max: 20, by: 1 }", /actions\.pick\.max: "20"/],
    ["{ set: 'padding', min: -1, max: 16, by: 1 }", /actions\.pick\.min: "-1"/],
    // A stepper over a domain of names is refused even when its ends are names.
    ["{ set: 'autoWrap', min: 0, max: 1, by: 1 }", /actions\.pick: a stepper writes the integers from 0 to 1, and autoWrap is not an integer range/],
    // An int cursor writes any integer the template binds.
    ["{ set: 'padding', int: true }", /actions\.pick\.int: .*padding takes an integer from 0 to 16/],
    ["{ set: 'theme', int: true }", /actions\.pick\.int: /],
    ["{ set: 'autoWrap', cycle: ['true', 'maybe'] }", /actions\.pick\.cycle: "maybe" .*true or false/],
    ["{ set: 'theme', to: 'no-such-theme' }", /actions\.pick\.to: "no-such-theme"/],
    ["{ set: 'variation', from: ['accent', 'plaid'] }", /actions\.pick\.from: "plaid"/],
    ["{ set: 'endcaps', from: 'styles' }", /actions\.pick\.from: "none"/],
    ["{ set: 'style', to: 'no-such-style' }", /actions\.pick\.to: "no-such-style"/],
    ["{ set: 'preset', to: 'no-such-preset' }", /actions\.pick\.to: "no-such-preset"/],
    // Not every value is an endcaps shape, so moving the key is not the fix.
    ["{ set: 'style', cycle: ['capsule', 'vivid'] }", /actions\.pick\.cycle: "capsule" is outside the style domain/],
    ["{ set: 'style', cycle: ['capsule', 'banana'] }", /actions\.pick\.cycle: "capsule", "banana" are outside/],
  ])("%s is a load error", (action, message) => {
    expect(() => load(action)).toThrow(message);
  });

  it("an endcaps shape under style points at the rename", () => {
    expect(() => load("{ set: 'style', to: 'capsule' }")).toThrow(
      /actions\.pick\.to: "capsule" is an endcaps shape, not a style .*write set: "endcaps", to: "capsule"/,
    );
  });

  it.each([
    "{ set: 'style', from: 'endcaps' }",
    "{ set: 'style', cycle: ['capsule', 'powerline'] }",
  ])("%s, writing only endcaps shapes, points at the key", (action) => {
    expect(() => load(action)).toThrow(
      /actions\.pick\.set: "style" here writes only endcaps shapes, not styles .*write set: "endcaps"$/m,
    );
  });

  it("a long domain is named, not listed", () => {
    const message = (() => {
      try {
        load("{ set: 'theme', to: 'nope' }");
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("loaded");
    })();
    expect(message).toMatch(
      new RegExp(
        `theme takes one of the ${listResolvablePaletteNames().length} "themes" names, such as "`,
      ),
    );
    expect(message).not.toContain(
      JSON.stringify(listResolvablePaletteNames().at(-1)),
    );
  });

  it("an outside list is capped", () => {
    expect(() => load("{ set: 'endcaps', from: 'styles' }")).toThrow(
      /actions\.pick\.from: "[^"]+", "[^"]+", "[^"]+" and \d+ more are outside/,
    );
  });

  // The doc's list of checked keys is prose an author trusts; it names
  // exactly the keys the check reads.
  it("docs/interaction-authoring.md names every setting key", () => {
    const doc = readFileSync(
      join(__dirname, "..", "docs", "interaction-authoring.md"),
      "utf8",
    );
    const listed = /A `set` on a setting's key \(([^)]*)\)/.exec(doc)![1]!;
    expect([...listed.matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort()).toEqual(
      [...SESSION_KEY_TO_SETTING.keys()].sort(),
    );
  });

  it.each([
    "{ set: 'endcaps', to: 'capsule' }",
    "{ set: 'padding', to: '16' }",
    "{ set: 'padding', min: 0, max: 16, by: 1 }",
    "{ set: 'autoWrap', cycle: ['true', 'false'] }",
    `{ set: 'theme', to: '${THEME}' }`,
    "{ set: 'theme', from: 'themes' }",
    "{ set: 'style', to: 'vivid' }",
    "{ set: 'style', from: 'styles' }",
    "{ set: 'variation', cycle: ['accent', 'duo'] }",
    "{ set: 'my.own.key', to: 'banana' }",
  ])("%s loads", (action) => {
    expect(() => load(action)).not.toThrow();
  });

  it("a declared style and preset are members", () => {
    expect(() =>
      parseAndValidate(
        "<set-domain-own>",
        `{
          styles: { mine: { hueShift: 10 } },
          actions: {
            a: { set: 'style', to: 'mine' },
            b: { set: 'preset', to: '${Object.keys(DEFAULT_DSL_CONFIG.presets)[0]}' },
          },
        }`,
        undefined,
        DEFAULT_DSL_CONFIG,
      ),
    ).not.toThrow();
  });
});
