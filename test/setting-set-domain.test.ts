// [LAW:verifiable-goals] brandon-config-dovk: a `set` on a setting's session
// key loads only when every value it can write is one the render resolves as a
// pick — otherwise the derived gate admits the value and the click does
// nothing. Run through the production cascade (DEFAULT_DSL_CONFIG), because
// the `styles` and `presets` domains are the merged config's.

import { parseAndValidate } from "./helpers/parse-and-validate";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { listResolvablePaletteNames } from "../src/themes/policy";

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
    ["{ set: 'padding', min: 0, max: 20, by: 1 }", /actions\.pick\.min: "20"/],
    ["{ set: 'autoWrap', cycle: ['true', 'maybe'] }", /actions\.pick\.cycle: "maybe" .*true or false/],
    ["{ set: 'theme', to: 'no-such-theme' }", /actions\.pick\.to: "no-such-theme"/],
    ["{ set: 'variation', from: ['accent', 'plaid'] }", /actions\.pick\.from: "plaid"/],
    ["{ set: 'endcaps', from: 'styles' }", /actions\.pick\.from: "none"/],
    ["{ set: 'style', to: 'no-such-style' }", /actions\.pick\.to: "no-such-style"/],
    ["{ set: 'preset', to: 'no-such-preset' }", /actions\.pick\.to: "no-such-preset"/],
  ])("%s is a load error", (action, message) => {
    expect(() => load(action)).toThrow(message);
  });

  it("an endcaps shape under style points at the rename", () => {
    expect(() => load("{ set: 'style', to: 'capsule' }")).toThrow(
      /actions\.pick\.to: "capsule" is an endcaps shape, not a style .*write set: "endcaps", to: "capsule"/,
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
    "{ set: 'padding', int: true }",
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
