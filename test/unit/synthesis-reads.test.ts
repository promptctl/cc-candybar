// What the settings menu, edit chrome and placement menus mint reads only
// payload inputs, projections and their own names, so its reads resolve
// whatever the config holds; a read nothing declares is named
// (brandon-settings-menu-d6f.6j4). Which names they mint follows the config:
// its presets, its placements, a segment's own settings, its `{{ menu }}`
// calls. So the cases are every shipped example plus an authored config that
// declares each of those.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import type { DslConfig } from "../../src/config/dsl-types";
import { EMPTY_DEFAULT, parseAndPlace } from "../helpers/parse-and-validate";
import { unresolvedReads } from "../helpers/synthesis-reads";

const AUTHORED = `{
  segments: {
    modelTag: {
      template: '{{ if .settings.icon }}◆ {{ end }}{{ if eq .settings.length "short" }}{{ trunc .settings.chars .model.display_name }}{{ else }}{{ .model.display_name }}{{ end }}',
      settings: {
        icon: { label: "Icon", domain: "bool", default: false },
        length: { label: "Length", domain: ["full", "short"], default: "full" },
        chars: { label: "Characters", domain: { min: 1, max: 12 }, default: 4 },
      },
    },
  },
  root: { h: ["modelTag", { seg: "modelTag", id: "shortTag", settings: { length: "short", icon: true } }] },
  presets: {
    compact: { globals: { padding: 0 }, root: { v: [{ seg: "modelTag", id: "tagOnly", settings: { chars: 2 } }] } },
    roomy: { globals: { padding: 2 } },
  },
}`;

const dir = (...parts: string[]): string =>
  join(__dirname, "..", "..", ...parts);
const examples = readdirSync(dir("examples"))
  .filter((name) => name.endsWith(".json5"))
  .map((name) => join("examples", name));

const cases: [string, string, DslConfig][] = [
  ["{} over the bundled default", "{}", DEFAULT_DSL_CONFIG],
  ["{} over a default that declares nothing", "{}", EMPTY_DEFAULT],
  ["authored presets and settings", AUTHORED, DEFAULT_DSL_CONFIG],
  ...[...examples, "test/fixtures/steel-thread.json5"].map(
    (path): [string, string, DslConfig] => [
      path,
      readFileSync(dir(path), "utf8"),
      DEFAULT_DSL_CONFIG,
    ],
  ),
];

describe("unresolvedReads", () => {
  test.each(cases)(
    "every read the chrome mints over %s resolves",
    (path, source, dflt) => {
      const { config, placed, dropped } = parseAndPlace(
        path,
        source,
        undefined,
        dflt,
      );
      expect(dropped).toEqual([]);
      expect(unresolvedReads(config, placed)).toEqual([]);
    },
  );

  test("a minted read that nothing declares is named", () => {
    const { config, placed } = parseAndPlace("<t>", "{}");
    const broken: DslConfig = {
      ...config,
      segments: { ...config.segments, minted: { template: "{{ .ghost }}" } },
    };
    expect(unresolvedReads(broken, placed)).toEqual(["ghost"]);
  });
});
