// [LAW:behavior-not-structure] A session key a config authors is refused at
// load exactly when it sits in a namespace where the bar mints its own keys,
// naming that namespace, by whichever route it is authored; any other key loads.

import { ConfigError } from "../../src/config/loader/diagnostics";
import { RESERVED_NAMESPACES } from "../../src/config/reserved-names";
import { listResolvablePaletteNames } from "../../src/themes/policy";
import { parseAndValidate } from "../helpers/parse-and-validate";

const ALLOWED = new Set(listResolvablePaletteNames());

// Each route a config authors a session key by, holding `key`.
const ROUTES: ReadonlyArray<readonly [string, (key: string) => string]> = [
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
  [
    "a menu's accordion key",
    (key) => `{
      actions: { pick: { set: "theme", from: "themes" } },
      segments: { s: { template: '{{ menu "pick" "▸" "▾" (dict "key" "${key}") }}' } },
      root: { h: ['s'] },
    }`,
  ],
];

const loadError = (src: string): string | null => {
  try {
    parseAndValidate("<user>", src, ALLOWED);
    return null;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return err.message;
  }
};

describe.each(ROUTES)("a session key authored by %s", (_route, config) => {
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
