// The settings menu and edit chrome mint names from whatever the config holds,
// and two sources of those names exist only once the chain has loaded: a
// plugin a config lists, with its segments and settings, and an insert landing
// in the trees of the layer beneath. A config drawn alone cuts the first as
// absent and has nowhere to put the second, so these cases load through the
// chain itself, show the chrome minted for those names, and hold what it
// minted, and the load's own advisories, to nothing unresolved.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { homeLayer, loadConfigChain } from "../src/config/dsl-loader";
import { placementIds } from "../src/config/dsl-types";
import { presetRoot } from "../src/config/presets";
import { rootNode } from "../src/config/root";
import { locs } from "./helpers/host";
import { jestTmpDir } from "./helpers/jest-tmp";
import { synthesisReads, unresolvedReads } from "./helpers/synthesis-reads";

describe("unresolvedReads over the loader's own chain", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = jestTmpDir("config");
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
    // The plugin's settings reach a settings row in each tree, the
    // placement's override included, so an empty list is over minted reads.
    const reads = [...synthesisReads(config, placed)];
    expect(reads).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^edit\.draft\.pdefault\..*\.chars$/),
        expect.stringMatching(/^edit\.draft\.pcompact\..*\.chars$/),
      ]),
    );
  });

  test("an insert into the presets of the layer beneath", () => {
    const { config, placed, dropped, warnings } = load(
      ["lower.json5", "upper.json5"],
      {
        "lower.json5": `{
        segments: { mine: { template: "mine" } },
        root: { h: ["mine"] },
        presets: { compact: { root: { v: ["mine"] } } },
      }`,
        "upper.json5": `{
        segments: { theirs: { template: "{{ .model.display_name }}" } },
        insert: [{ seg: "theirs", after: "mine" }],
      }`,
      },
    );
    expect(dropped).toEqual([]);
    expect(warnings).toEqual([]);
    expect(placementIds(rootNode(config.root))).toContain("theirs");
    expect(placementIds(presetRoot(config, "compact").node)).toContain(
      "theirs",
    );
    expect(unresolvedReads(config, placed)).toEqual([]);
    // The chrome reached the inserted cell in each tree it landed in.
    expect(Object.keys(config.segments)).toEqual(
      expect.arrayContaining([
        "edit.label:theirs/default:theirs",
        "edit.label:theirs/compact:theirs",
      ]),
    );
  });
});
