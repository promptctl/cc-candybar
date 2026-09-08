// [LAW:single-enforcer] The plugin's template, preview script and wizard prompt
// are three media that cannot share a type; this suite keeps them one system.
// [LAW:one-source-of-truth] Value domains come from the SOURCE the loader
// validates against, never from a list restated here.

import fs from "node:fs";
import path from "node:path";

import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { presetNames } from "../src/config/presets";
import {
  CHARSETS,
  STRIP_STYLES,
  listResolvablePaletteNames,
} from "../src/themes/policy";
import { checkText } from "./helpers/check-config";

const pluginDir = path.join(__dirname, "..", "plugin");
const templatesDir = path.join(pluginDir, "templates");
const previewScript = fs.readFileSync(
  path.join(pluginDir, "bin", "preview.sh"),
  "utf8",
);
const wizardDoc = fs.readFileSync(
  path.join(pluginDir, "commands", "candybar.md"),
  "utf8",
);

const DOMAINS: Readonly<Record<string, readonly string[]>> = {
  THEME: listResolvablePaletteNames(),
  STYLE: STRIP_STYLES,
  CHARSET: CHARSETS,
  PRESET: presetNames(DEFAULT_DSL_CONFIG.presets),
};

// [LAW:parse-dont-validate] A placeholder with no domain row above is an untested claim, and fails here by name.
function domainOf(name: string): readonly string[] {
  const domain = DOMAINS[name];
  if (domain === undefined) {
    throw new Error(`placeholder replace:${name} has no domain in this suite`);
  }
  return domain;
}

function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/replace:([A-Z_]+)/g)].map((m) => m[1]!))].sort();
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/replace:([A-Z_]+)/g, (_, name: string) => values[name]!);
}

function previewArray(name: string): string[] {
  const line = previewScript.match(new RegExp(`^readonly ${name}=\\((.*)\\)$`, "m"));
  if (line === null) {
    throw new Error(`preview.sh declares no \`readonly ${name}=(...)\` array`);
  }
  return line[1]!.trim().split(/\s+/);
}

const templateFiles = fs
  .readdirSync(templatesDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

const templatePlaceholders = placeholdersIn(
  templateFiles
    .map((f) => fs.readFileSync(path.join(templatesDir, f), "utf8"))
    .join("\n"),
);

describe("plugin config templates (plugin/templates/*.json)", () => {
  // A moved directory would make every describe.each vanish and the suite pass vacuously.
  test("the wizard's template is present", () => {
    expect(templateFiles).toContain("config.json");
  });

  describe.each(templateFiles)("%s", (file) => {
    const template = fs.readFileSync(path.join(templatesDir, file), "utf8");
    const names = placeholdersIn(template);

    const base = Object.fromEntries(names.map((n) => [n, domainOf(n)[0]!]));
    const fills = names.flatMap((n) =>
      domainOf(n).map((v): [string, Record<string, string>] => [
        `${n}=${v}`,
        { ...base, [n]: v },
      ]),
    );

    test.each(fills)(
      "filled with %s is clean under `cc-candybar check` and renders",
      async (label, values) => {
        const filled = fill(template, values);
        expect(placeholdersIn(filled)).toEqual([]);
        await checkText(`${file} ${label}`, filled);
      },
    );
  });
});

describe("plugin/bin/preview.sh renders the same template it offers", () => {
  test("substitutes exactly the template's placeholders", () => {
    expect(placeholdersIn(previewScript)).toEqual(templatePlaceholders);
  });

  // The theme shortlist may be a subset; the other three are closed vocabularies offered in full.
  test("THEMES names only palettes the daemon resolves", () => {
    const themes = previewArray("THEMES");
    expect(themes.length).toBeGreaterThan(0);
    expect(themes.filter((t) => !DOMAINS.THEME!.includes(t))).toEqual([]);
  });

  test.each([
    ["STYLES", "STYLE"],
    ["CHARSETS", "CHARSET"],
    ["PRESETS", "PRESET"],
  ])("%s is exactly the daemon's %s domain", (array, domain) => {
    expect([...previewArray(array)].sort()).toEqual([...DOMAINS[domain]!].sort());
  });
});

describe("plugin/commands/candybar.md fills the template it ships", () => {
  test("names exactly the template's placeholders", () => {
    expect(placeholdersIn(wizardDoc)).toEqual(templatePlaceholders);
  });

  test("drives the preview script only through flags it accepts", () => {
    const usage = previewScript.match(/^\s*printf 'Usage: preview\.sh (.*)\\n' >&2$/m);
    if (usage === null) throw new Error("preview.sh prints no usage line");
    const accepted = new Set([...usage[1]!.matchAll(/--[a-z-]+/g)].map((m) => m[0]));
    const used = [...new Set([...wizardDoc.matchAll(/preview\.sh([^\n`]*)/g).flatMap((m) => [...m[1]!.matchAll(/--[a-z-]+/g)].map((f) => f[0]))])];
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((f) => !accepted.has(f))).toEqual([]);
  });
});
