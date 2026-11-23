// [LAW:verifiable-goals] brandon-config-dovk: a `set` on a setting's session
// key loads only when every value it can write is one the render resolves as a
// pick — otherwise the derived gate admits the value and the click does
// nothing. Run through the production cascade (DEFAULT_DSL_CONFIG), because
// the `styles` and `presets` domains are the merged config's.

import { parseAndValidate } from "../helpers/parse-and-validate";
import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import { listResolvablePaletteNames } from "../../src/themes/policy";
import { SESSION_KEY_TO_SETTING } from "../../src/config/setting-projections";
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
    [
      "{ set: 'endcaps', to: 'banana' }",
      /actions\.pick\.to: "banana" is outside the endcaps domain.*takes one of .*"powerline"/,
    ],
    [
      "{ set: 'padding', to: '99' }",
      /actions\.pick\.to: "99" .*an integer from 0 to 16/,
    ],
    ["{ set: 'padding', to: '3 ' }", /actions\.pick\.to: "3 "/],
    // The session holds an integer as String(n) writes it, nothing else.
    ["{ set: 'padding', to: '-0' }", /actions\.pick\.to: "-0"/],
    ["{ set: 'padding', to: '007' }", /actions\.pick\.to: "007"/],
    // A stepper's bad end is reported at the end that states it.
    ["{ set: 'padding', min: 0, max: 20, by: 1 }", /actions\.pick\.max: "20"/],
    ["{ set: 'padding', min: -1, max: 16, by: 1 }", /actions\.pick\.min: "-1"/],
    // A stepper over a domain of names is refused even when its ends are names.
    [
      "{ set: 'autoWrap', min: 0, max: 1, by: 1 }",
      /actions\.pick: a stepper writes the integers from 0 to 1, and autoWrap is not an integer range/,
    ],
    // An int cursor writes any integer the template binds.
    [
      "{ set: 'padding', int: true }",
      /actions\.pick\.int: .*padding takes an integer from 0 to 16/,
    ],
    ["{ set: 'theme', int: true }", /actions\.pick\.int: /],
    [
      "{ set: 'autoWrap', cycle: ['true', 'maybe'] }",
      /actions\.pick\.cycle: "maybe" .*true or false/,
    ],
    [
      "{ set: 'theme', to: 'no-such-theme' }",
      /actions\.pick\.to: "no-such-theme"/,
    ],
    [
      "{ set: 'variation', from: ['accent', 'plaid'] }",
      /actions\.pick\.from: "plaid"/,
    ],
    ["{ set: 'endcaps', from: 'styles' }", /actions\.pick\.from: "none"/],
    [
      "{ set: 'style', to: 'no-such-style' }",
      /actions\.pick\.to: "no-such-style"/,
    ],
    [
      "{ set: 'preset', to: 'no-such-preset' }",
      /actions\.pick\.to: "no-such-preset"/,
    ],
    // Not every value is an endcaps shape, so moving the key is not the fix.
    [
      "{ set: 'style', cycle: ['capsule', 'vivid'] }",
      /actions\.pick\.cycle: "capsule" is outside the style domain/,
    ],
    [
      "{ set: 'style', cycle: ['capsule', 'banana'] }",
      /actions\.pick\.cycle: "capsule", "banana" are outside/,
    ],
    // A joiner added since the rename is a name a style may take: no such style.
    [
      "{ set: 'style', to: 'slant' }",
      /actions\.pick\.to: "slant" is outside the style domain/,
    ],
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

  it("a refusal lists every member the author could have meant", () => {
    const message = (() => {
      try {
        load("{ set: 'theme', to: 'nope' }");
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("loaded");
    })();
    for (const name of listResolvablePaletteNames()) {
      expect(message).toContain(JSON.stringify(name));
    }
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
      join(__dirname, "..", "..", "docs", "interaction-authoring.md"),
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

// [LAW:verifiable-goals] A `persist` writes the file the loader reads, so each
// value it can write is judged as the loader judges that value in the file it
// lands in (the schema of that place, then the merged config's membership) and
// refused at load, at the action's own field, rather than at the click.
describe("a persist is judged by the loader's verdict on the file it writes", () => {
  const refused = (value: string, why: string): RegExp =>
    new RegExp(
      `actions\\.pick\\.(to|cycle|from|min|max): persisting ${value} would write a file the loader refuses.* — .*${why}`,
    );
  it.each([
    [
      "{ persist: 'padding', to: '99' }",
      refused('"99"', "padding must be an integer between 0 and 16"),
    ],
    [
      "{ persist: 'padding', min: 0, max: 20, by: 1 }",
      /actions\.pick\.max: persisting "20"/,
    ],
    [
      "{ persist: 'autoWrap', cycle: ['true', 'maybe'] }",
      /actions\.pick\.cycle: persisting "maybe" .* expects boolean-ish/,
    ],
    [
      "{ persist: 'palette', to: 'no-such-theme' }",
      refused('"no-such-theme"', 'Unknown palette "no-such-theme"'),
    ],
    [
      "{ persist: 'style', to: 'no-such-style' }",
      refused('"no-such-style"', "does not match any declared style"),
    ],
    [
      "{ persist: 'preset', to: 'no-such-preset' }",
      refused('"no-such-preset"', "does not match any declared preset"),
    ],
    [
      "{ persist: 'presets.compact.globals.padding', to: '99' }",
      refused('"99"', "padding must be an integer between 0 and 16"),
    ],
    [
      "{ persist: 'themeDefaults.nord.shade', to: 'no-such-shade' }",
      refused('"no-such-shade"', "themeDefaults\\.nord"),
    ],
    // The old spelling of endcaps names where the file wants it.
    [
      "{ persist: 'style', to: 'capsule' }",
      refused('"capsule"', 'write globals\\.endcaps: "capsule"'),
    ],
    // A rule is a member only where the file's schema takes one: a number, an
    // enum and a theme's default style refuse it, a theme or style rule loads.
    [
      "{ persist: 'padding', to: '{{ .session.model }}' }",
      refused('"\\{\\{ \\.session\\.model \\}\\}"', "expects an integer"),
    ],
    [
      "{ persist: 'shade', to: '{{ .session.model }}' }",
      refused('"\\{\\{ \\.session\\.model \\}\\}"', "shade"),
    ],
    [
      "{ persist: 'themeDefaults.nord.style', to: '{{ .session.model }}' }",
      refused(
        '"\\{\\{ \\.session\\.model \\}\\}"',
        "a rule is not allowed here",
      ),
    ],
    // A segment's palette is judged by the loader's palette check, as the
    // theme default and the top-level field are.
    [
      "{ persist: 'segments.s.palette', to: 'no-such-theme' }",
      refused('"no-such-theme"', 'Unknown palette "no-such-theme"'),
    ],
    [
      "{ persist: 'segments.s.palette', cycle: ['no-such-theme', 'also-not'] }",
      refused('"no-such-theme", "also-not"', 'Unknown palette "no-such-theme"'),
    ],
    // The file holds the integer as the session does: as written, plainly.
    [
      "{ persist: 'padding', to: '0x10' }",
      refused('"0x10"', "expects an integer written plainly"),
    ],
    // A stepper writes integers, which a boolean field does not hold.
    [
      "{ persist: 'autoWrap', min: 0, max: 1, by: 1 }",
      /actions\.pick: a stepper writes the integers from 0 to 1, and autoWrap does not hold an integer/,
    ],
    // A field no session pick sets is judged by its own schema all the same.
    [
      "{ persist: 'colorCompatibility', to: 'bogus' }",
      refused('"bogus"', "colorCompatibility"),
    ],
  ])("%s is a load error", (action, message) => {
    expect(() => load(action)).toThrow(message);
  });

  it.each([
    "{ persist: 'padding', to: '16' }",
    "{ persist: 'padding', min: 0, max: 16, by: 1 }",
    "{ persist: 'autoWrap', cycle: ['true', 'false'] }",
    `{ persist: 'palette', to: '${THEME}' }`,
    "{ persist: 'palette', from: 'themes' }",
    "{ persist: 'style', from: 'styles' }",
    "{ persist: 'palette', to: '{{ if .session.model }}nord{{ end }}' }",
    "{ persist: 'style', to: '{{ if .session.model }}vivid{{ end }}' }",
    "{ persist: 'colorCompatibility', cycle: ['truecolor', '256'] }",
    // A style the bundled default declares is a member through the merge.
    "{ persist: 'style', to: 'vivid' }",
    // A tree op writes a layout, which no setting holds.
    "{ persist: 'presets.default.root', removeSegment: 'gitaculous' }",
  ])("%s loads", (action) => {
    expect(() => load(action)).not.toThrow();
  });
});
