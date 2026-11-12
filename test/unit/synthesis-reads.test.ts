// What the settings menu, edit chrome and placement menus mint reads only
// payload inputs, projections and their own names, so its reads resolve
// whatever the config holds; a read nothing declares is named
// (brandon-settings-menu-d6f.6j4). The authored configs carry what shapes the
// minted names: several presets, segments' own settings, `{{ menu }}` calls.

import { readFileSync } from "node:fs";
import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import type { DslConfig } from "../../src/config/dsl-types";
import { EMPTY_DEFAULT, parseAndPlace } from "../helpers/parse-and-validate";
import { unresolvedReads } from "../helpers/synthesis-reads";

const file = (path: string): [string, string] => [
  path,
  readFileSync(path, "utf8"),
];

const cases: [string, string, DslConfig][] = [
  ["{} over the bundled default", "{}", DEFAULT_DSL_CONFIG],
  ["{} over a default that declares nothing", "{}", EMPTY_DEFAULT],
  ...[
    file("examples/showcase.json5"),
    file("test/fixtures/steel-thread.json5"),
  ].map(([path, source]): [string, string, DslConfig] => [
    path,
    source,
    DEFAULT_DSL_CONFIG,
  ]),
];

describe("unresolvedReads", () => {
  test.each(cases)("every read the chrome mints over %s resolves", (path, source, dflt) => {
    const { config, placed } = parseAndPlace(path, source, undefined, dflt);
    expect(unresolvedReads(config, placed)).toEqual([]);
  });

  test("a minted read that nothing declares is named", () => {
    const { config, placed } = parseAndPlace("<t>", "{}");
    const broken: DslConfig = {
      ...config,
      segments: { ...config.segments, minted: { template: "{{ .ghost }}" } },
    };
    expect(unresolvedReads(broken, placed)).toEqual(["ghost"]);
  });
});
