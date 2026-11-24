// [LAW:behavior-not-structure] A session key a config authors is refused at
// load exactly when it could meet one the bar mints, naming the namespace:
// a raw key (a state key, a `set` target, a group's key) anywhere in a
// reserved namespace, and a menu's accordion key only where its menu key
// meets the bar's own. Any other key loads.

import { ConfigError } from "../../src/config/loader/diagnostics";
import { RESERVED_NAMESPACES } from "../../src/config/reserved-names";
import { listResolvablePaletteNames } from "../../src/themes/policy";
import { parseAndValidate } from "../../scripts/lib/draw-fixtures/parse-and-validate";

const ALLOWED = new Set(listResolvablePaletteNames());

// Each route a config authors a raw session key by, holding `key`.
const RAW: ReadonlyArray<readonly [string, (key: string) => string]> = [
  [
    "a state variable",
    (key) => `{
      variables: { v: { kind: "state", key: "${key}", default: "a" } },
      segments: { s: { template: '{{ .v }}' } },
      root: { h: ['s'] },
    }`,
  ],
  [
    "a segment's state var",
    (key) => `{
      segments: { s: { template: '{{ .s.v }}', vars: { v: { kind: "state", key: "${key}", default: "a" } } } },
      root: { h: ['s'] },
    }`,
  ],
  [
    "a set action",
    (key) => `{
      actions: { go: { set: "${key}", to: "a" } },
      segments: { s: { template: '{{ action "go" "x" }}' } },
      root: { h: ['s'] },
    }`,
  ],
  [
    "a group's key",
    (key) => `{
      segments: { s: { template: 's' } },
      root: { h: [{ kind: "group", name: "g", label: "g", key: "${key}", children: ["s"] }] },
    }`,
  ],
];

const accordion = (key: string): string => `{
  actions: { pick: { set: "theme", from: "themes" } },
  segments: { s: { template: '{{ menu "pick" "▸" "▾" (dict "key" "${key}") }}' } },
  root: { h: ['s'] },
}`;

const loadError = (src: string): string | null => {
  try {
    parseAndValidate("<user>", src, ALLOWED);
    return null;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return err.message;
  }
};

describe.each(RAW)("a session key authored by %s", (_route, config) => {
  test.each([...RESERVED_NAMESPACES])(
    "in the %s namespace is refused, naming it",
    (ns) => {
      expect(loadError(config(`${ns}x`))).toContain(
        `session key "${ns}x" is in the "${ns}" namespace`,
      );
    },
  );

  test.each(["mine", "editx", "menus", "candybar-pickers", "groups_x"])(
    "%s loads",
    (key) => {
      expect(loadError(config(key))).toBeNull();
    },
  );
});

describe("a menu's accordion key", () => {
  test.each([
    ["edit.live", 'names an accordion in the "edit." namespace'],
    ["candybar.pickers", "names the settings menu's own accordion"],
    ["candybar.gearPickers", "names the settings menu's own accordion"],
  ])("%s, which meets the bar's own, is refused", (key, why) => {
    expect(loadError(accordion(key))).toContain(`session key "${key}" ${why}`);
  });

  test.each([
    "mine",
    "menus.x",
    "menupages.x",
    "groups.x",
    "candybar.x",
    "candybar-pickers",
  ])("%s, which meets nothing, loads", (key) => {
    expect(loadError(accordion(key))).toBeNull();
  });
});
