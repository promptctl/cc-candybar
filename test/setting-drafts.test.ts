// [LAW:verifiable-goals] brandon-save-undo-bwi.hpi: a draft is what the
// session renders differently from the file, and a save lands each one where
// the next reload reads it. The bundled `compact` preset authors its own
// `padding: 0`, which wins over top-level `globals` while it is active — the
// case that decides where a save must write and what a pick compares against.

import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { mergeWithDefault } from "../src/config/dsl-loader";
import {
  parsePersistTarget,
  persistPath,
} from "../src/config/loader/persist-target";
import { presetGlobals } from "../src/config/presets";
import { settingDrafts } from "../src/daemon/setting-drafts";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { EMPTY_DEFAULT, parseAndValidate } from "./helpers/parse-and-validate";
import { SETTINGS } from "../src/config/setting-projections";
import { writeValues } from "../src/daemon/config-file-store";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";

const ALLOWED = new Set(listResolvablePaletteNames());
const config = (source: string) =>
  parseAndValidate("<user>", source, ALLOWED, DEFAULT_DSL_CONFIG);
const picks =
  (p: Record<string, string>) =>
  (key: string): string | null =>
    p[key] ?? null;
const drafts = (source: string, p: Record<string, string>) =>
  settingDrafts(config(source), picks(p)).map(({ sessionKey, value, target }) => ({
    sessionKey,
    value,
    target,
  }));

describe("settingDrafts", () => {
  const FILE = `{ globals: { padding: 1 } }`;

  test("a field the picked preset authors lands in that preset's globals", () => {
    expect(drafts(FILE, { preset: "compact", padding: "2" })).toEqual([
      { sessionKey: "preset", value: "compact", target: "preset" },
      {
        sessionKey: "padding",
        value: "2",
        target: "presets.compact.globals.padding",
      },
    ]);
  });

  test("a pick equal to the file's top-level value is still a draft when the preset shadows it", () => {
    expect(drafts(FILE, { preset: "compact", padding: "1" })).toContainEqual({
      sessionKey: "padding",
      value: "1",
      target: "presets.compact.globals.padding",
    });
  });

  test("a pick equal to what the saved preset renders is no draft", () => {
    expect(drafts(FILE, { preset: "compact", padding: "0" })).toEqual([
      { sessionKey: "preset", value: "compact", target: "preset" },
    ]);
  });

  test("a field no preset authors lands in top-level globals", () => {
    expect(drafts(FILE, { padding: "3" })).toEqual([
      { sessionKey: "padding", value: "3", target: "padding" },
    ]);
  });

  test("a pick the render ignores is no draft", () => {
    expect(drafts(FILE, { preset: "gone", look: "gone", theme: "gone" })).toEqual(
      [],
    );
  });

  test("a theme chosen by rule is no draft until a name is picked over it", () => {
    const RULE = `{ globals: { palette: '{{ "nord" }}' } }`;
    expect(drafts(RULE, {})).toEqual([]);
    expect(drafts(RULE, { theme: "nord" })).toEqual([
      { sessionKey: "theme", value: "nord", target: "palette" },
    ]);
  });

  test("edit mode's staged globals are never a draft", () => {
    expect(drafts(FILE, { "edit.mode": "arrange" })).toEqual([]);
  });
});

describe("a preset's globals as a write target", () => {
  test("parses, and names its path in the file", () => {
    const target = parsePersistTarget("presets.v1.compact.globals.padding");
    expect(target).toEqual({
      scope: "preset-globals",
      preset: "v1.compact",
      field: "padding",
    });
    expect(persistPath(target as never)).toEqual([
      "presets",
      "v1.compact",
      "globals",
      "padding",
    ]);
    expect(parsePersistTarget("presets.compact.globals.nope")).toBeNull();
    // A fragment cannot author these, so neither can a write into one.
    expect(parsePersistTarget("presets.compact.globals.preset")).toBeNull();
    expect(parsePersistTarget("presets.compact.globals.menuGlyph")).toBeNull();
  });

  test("a file's fragment merges over the base preset's field by field", () => {
    const base = {
      ...EMPTY_DEFAULT,
      presets: { wide: { globals: { padding: 0, style: "plain" as const } } },
    };
    const merged = mergeWithDefault(
      { presets: { wide: { globals: { padding: 2 } } } },
      base,
    );
    expect(presetGlobals(merged, "wide")).toMatchObject({
      padding: 2,
      style: "plain",
    });
  });
});

// ─── A save under a preset that pins the field (brandon-menu-ia-zyf) ────────
//
// A user preset pinning a display global shadows the file's top-level value,
// so a save written to top-level `globals` would change nothing the bar shows.
// Measured for EVERY setting, both ways a preset becomes active (the file
// names it, or the session picks it): the drafts are written through the real
// `writeValues`, the file is read back, and the file alone must now resolve to
// what the session rendered — no draft left over. Keyed by setting name, so a
// new setting is a compile error here until it has a row.
type PinnedSetting = Exclude<keyof typeof SETTINGS, "preset">;
const PIN_AND_PICK: Record<PinnedSetting, { pin: string; pick: string }> = {
  theme: { pin: "'nord'", pick: "gruvbox" },
  look: { pin: "'dim'", pick: "vivid" },
  style: { pin: "'capsule'", pick: "plain" },
  progression: { pin: "'primary'", pick: "primary-secondary" },
  charset: { pin: "'ascii'", pick: "unicode" },
  colorCompatibility: { pin: "'256'", pick: "ansi" },
  autoWrap: { pin: "false", pick: "true" },
  padding: { pin: "3", pick: "2" },
  updateNotice: { pin: "false", pick: "true" },
};

describe("a save under a preset that pins the field lands where it renders", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-candybar-drafts-pin-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const save = (source: string, p: Record<string, string>) => {
    const file = join(dir, "config.json5");
    writeFileSync(file, source);
    const before = drafts(source, p);
    writeValues(
      { record: () => {}, logger: () => {} },
      file,
      before.map(({ target, value }) => [target, value] as const),
    );
    const after = readFileSync(file, "utf8");
    return { before, after, left: drafts(after, p) };
  };

  test.each(Object.entries(PIN_AND_PICK) as [PinnedSetting, { pin: string; pick: string }][])(
    "%s",
    (name, { pin, pick }) => {
      const { configKey, sessionKey } = SETTINGS[name];
      const target = `presets.mine.globals.${configKey}`;
      const preset = `presets: { mine: { globals: { ${configKey}: ${pin} } } }`;

      // The file names the preset: only the field is a draft.
      const named = save(`{ globals: { preset: 'mine' }, ${preset} }`, {
        [sessionKey]: pick,
      });
      expect(named.before).toEqual([{ sessionKey, value: pick, target }]);
      expect(named.left).toEqual([]);
      expect(JSON5.parse(named.after).globals).not.toHaveProperty(configKey);

      // The session picks the preset: it saves too, and the field still lands
      // in the preset the file will now name (the `landed` resolution).
      const picked = save(`{ ${preset} }`, { preset: "mine", [sessionKey]: pick });
      expect(picked.before).toContainEqual({ sessionKey, value: pick, target });
      expect(picked.left).toEqual([]);
      expect(JSON5.parse(picked.after).globals).toEqual({ preset: "mine" });
    },
  );
});
