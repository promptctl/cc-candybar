// [LAW:verifiable-goals] The Claude Code plugin (plugin/) ships a config
// template the `/candybar` wizard fills and installs, a preview script that
// renders the same template, and the wizard prompt that names the placeholders
// and drives the script. Three files in three media — JSON, bash, markdown —
// cannot share a type, so this suite is the enforcer that keeps them one
// system: every config the wizard can produce loads under `cc-candybar check`,
// every option name the preview offers is one the daemon accepts, and all
// three files agree on the placeholder set. Before it existed, every shipped
// template had silently rotted to a config model the loader retired
// (brandon-plugin-templates-irq).
//
// [LAW:single-enforcer] The pipeline driven here IS `cc-candybar check` — the
// same entry function the CLI runs and the daemon's own load+render path — so
// "the wizard's config passes check" and "the bar renders it" are one fact.
//
// [LAW:one-source-of-truth] The value domains come from the SOURCE the loader
// validates against (palette registry, STRIP_STYLES, CHARSETS, the bundled
// presets), never from a list restated here. The template directory is
// globbed, so a template added later is covered on arrival.

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

// Placeholder name → every value the wizard may put there.
const DOMAINS: Readonly<Record<string, readonly string[]>> = {
  THEME: listResolvablePaletteNames(),
  STYLE: STRIP_STYLES,
  CHARSET: CHARSETS,
  PRESET: presetNames(DEFAULT_DSL_CONFIG.presets),
};

// [LAW:parse-dont-validate] The one crossing from a placeholder name to its
// domain. A placeholder the template introduces without a row above is an
// untested claim, and fails the suite here, by name, as it is collected.
function domainOf(name: string): readonly string[] {
  const domain = DOMAINS[name];
  if (domain === undefined) {
    throw new Error(`placeholder replace:${name} has no domain in this suite`);
  }
  return domain;
}

// The wizard's own placeholder spelling, `replace:NAME`, wherever it appears.
function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/replace:([A-Z_]+)/g)].map((m) => m[1]!))].sort();
}

// The wizard's substitution: every placeholder replaced by its chosen value.
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/replace:([A-Z_]+)/g, (_, name: string) => values[name]!);
}

// A bash `readonly NAME=(a b c)` line's members.
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
  // Guard against the glob matching nothing (a moved directory would make
  // every describe.each below vanish and the suite pass vacuously).
  test("the wizard's template is present", () => {
    expect(templateFiles).toContain("config.json");
  });

  describe.each(templateFiles)("%s", (file) => {
    const template = fs.readFileSync(path.join(templatesDir, file), "utf8");
    const names = placeholdersIn(template);

    // One fill per (placeholder, value): the first member of every domain as
    // the base, with one placeholder swept over its whole domain at a time.
    // Every value the wizard can offer is exercised; the loader's per-key
    // validation is what makes the axes independent.
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
  // The script fills the template with sed; the tokens it substitutes must be
  // exactly the template's, else the preview renders a config the wizard
  // never writes, or leaves a placeholder the loader rejects.
  test("substitutes exactly the template's placeholders", () => {
    expect(placeholdersIn(previewScript)).toEqual(templatePlaceholders);
  });

  // The curated theme shortlist may be a subset of the registry; the other
  // three lists are closed vocabularies the wizard should offer in full.
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
