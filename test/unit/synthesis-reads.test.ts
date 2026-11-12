// What the settings menu, edit chrome and placement menus mint reads only
// payload inputs, projections and their own names, so its reads resolve
// whatever the config holds; a read nothing declares is named
// (brandon-settings-menu-d6f.6j4). Which names they mint follows the config:
// its presets, its placements, a segment's own settings, its `{{ menu }}`
// calls. So the cases are every shipped example plus an authored config that
// declares each of those.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import { homeLayer, loadConfigChain } from "../../src/config/dsl-loader";
import { placementIds, type DslConfig } from "../../src/config/dsl-types";
import { presetRoot } from "../../src/config/presets";
import { rootNode } from "../../src/config/root";
import { locs } from "../helpers/host";
import { jestTmpDir } from "../helpers/jest-tmp";
import { EMPTY_DEFAULT, parseAndPlace } from "../helpers/parse-and-validate";
import { unresolvedReads } from "../helpers/synthesis-reads";

const AUTHORED = `{
  actions: { applyTheme: { set: "theme", from: "themes" } },
  segments: {
    modelTag: {
      template: '{{ if .settings.icon }}◆ {{ end }}{{ if eq .settings.length "short" }}{{ trunc .settings.chars .model.display_name }}{{ else }}{{ .model.display_name }}{{ end }}',
      settings: {
        icon: { label: "Icon", domain: "bool", default: false },
        length: { label: "Length", domain: ["full", "short"], default: "full" },
        chars: { label: "Characters", domain: { min: 1, max: 12 }, default: 4 },
      },
    },
    themePick: { template: '{{ menu "applyTheme" "▸" "▾" }}' },
  },
  root: { h: ["themePick", "modelTag", { seg: "modelTag", id: "shortTag", settings: { length: "short", icon: true } }] },
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

const cases: Array<[string, string, DslConfig]> = [
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

  test("a minted variable's unresolved read is named", () => {
    const { config, placed } = parseAndPlace("<t>", "{}");
    const broken: DslConfig = {
      ...config,
      variables: {
        ...config.variables,
        minted: { kind: "template", template: "{{ .ghost }}" },
      },
    };
    expect(unresolvedReads(broken, placed)).toEqual(["ghost"]);
  });
});

// The cases above draw with no plugin rendering and no layer beneath, so a
// plugin's placement is cut as absent and an insert has no lower tree to land
// in. These load through the chain itself, over the setup's isolated host, so
// the names a rendering plugin and a beneath layer make the chrome mint reach
// the synthesis, and the load's own advisories are part of the proof.
describe("unresolvedReads over the loader's own chain", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = jestTmpDir("config");
    mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  // Layers are listed lowest first; files are everything written, layers or not.
  const load = (layers: string[], files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(tmp, name)), { recursive: true });
      writeFileSync(join(tmp, name), text);
    }
    const warnings: string[] = [];
    const loaded = loadConfigChain(
      locs(),
      layers.map((name) => homeLayer(join(tmp, name))),
      DEFAULT_DSL_CONFIG,
      { warned: (ws) => warnings.push(...ws) },
      { repo: null, cwd: null },
    );
    return { ...loaded, warnings };
  };

  test("a rendering plugin's segment, its settings and a placement's override", () => {
    const { config, placed, dropped, warnings } = load(["config.json5"], {
      "p/plugin.json5": `{
        segments: {
          tag: {
            template: '{{ if .settings.icon }}◆ {{ end }}{{ if eq .settings.length "short" }}{{ trunc .settings.chars .model.display_name }}{{ else }}{{ .model.display_name }}{{ end }}',
            settings: {
              icon: { label: "Icon", domain: "bool", default: false },
              length: { label: "Length", domain: ["full", "short"], default: "full" },
              chars: { label: "Characters", domain: { min: 1, max: 12 }, default: 4 },
            },
          },
        },
      }`,
      "config.json5": `{
        plugins: ["./p/plugin.json5"],
        root: { h: ["model", "plugins.p.tag"] },
        presets: { compact: { root: { h: [{ seg: "plugins.p.tag", id: "short", settings: { length: "short" } }] } } },
      }`,
    });
    expect(dropped).toEqual([]);
    expect(warnings).toEqual([]);
    expect(placementIds(rootNode(config.root))).toContain("plugins.p.tag");
    expect(placementIds(presetRoot(config, "compact").node)).toContain("short");
    expect(unresolvedReads(config, placed)).toEqual([]);
  });

  test("an insert into the presets of the layer beneath", () => {
    const { config, placed, dropped, warnings } = load(
      ["lower.json5", "upper.json5"],
      {
        "lower.json5": `{
        segments: { mine: { template: "mine" } },
        root: { h: ["mine"] },
        presets: { compact: { globals: { padding: 0 }, root: { v: ["mine"] } } },
      }`,
        "upper.json5": `{
        segments: { theirs: { template: "{{ .model.display_name }}" } },
        insert: [{ seg: "theirs", after: "mine" }],
      }`,
      },
    );
    expect(dropped).toEqual([]);
    expect(warnings).toEqual([]);
    expect(placementIds(presetRoot(config, "compact").node)).toContain(
      "theirs",
    );
    expect(unresolvedReads(config, placed)).toEqual([]);
  });
});
