// [LAW:behavior-not-structure] A session's pick reads through its setting's
// one parse into unset, held or stale, and folds under the one precedence; a
// stale pick that decided gets one message naming the setting, the spelling,
// what the bar wears and what the setting can hold, and asking for a pick.

import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import { placementDraftKey } from "../../src/config/edit-chrome";
import { settingTable, placementFold } from "../../src/config/setting-table";
import { staleWarnings } from "../../src/dsl/stale-warnings";
import {
  BOOLEAN_MEMBERS,
  foldSetting,
  heldBy,
  listResolvablePaletteNames,
  placementThemeNames,
} from "../../src/themes/policy";
import { parseSettingSpelling } from "../../src/config/dsl-types";
import { parseAndValidate } from "../../scripts/lib/draw-fixtures/parse-and-validate";

const ALLOWED = new Set(listResolvablePaletteNames());

const CONFIG = parseAndValidate(
  "<user>",
  `{
    styles: { vapor: { hueShift: 90 } },
    presets: { roomy: { globals: { padding: 3 } } },
    segments: {
      probe: {
        template: "{{ .settings.size }}",
        settings: { size: { label: "Size", domain: { min: 0, max: 5 }, default: 1 } },
      },
    },
    root: { h: [{ seg: "probe", id: "probe", settings: { size: 3 } }] },
  }`,
  ALLOWED,
  DEFAULT_DSL_CONFIG,
);
const TABLE = settingTable(CONFIG);
const SIZE = placementDraftKey(
  { preset: "default", id: "probe", segment: "probe" },
  "size",
);

const sizeRow = () => {
  const row = TABLE.placements.find((p) => p.key === SIZE);
  if (row === undefined) throw new Error(`no row for ${SIZE}`);
  return row;
};

describe("a pick read through its setting's parse", () => {
  test("is unset, held, or stale with the spelling it holds", () => {
    const parse = (raw: string) => (raw === "ok" ? raw : null);
    expect(heldBy(null, parse)).toEqual({ kind: "unset" });
    expect(heldBy("ok", parse)).toEqual({ kind: "held", value: "ok" });
    expect(heldBy("gone", parse)).toEqual({ kind: "stale", raw: "gone" });
  });

  // The picker offers the domain's members and the row's parse admits what the
  // fold may hold: the two must agree, or a menu offers a value the next frame
  // warns it cannot hold.
  test("a placement's theme row admits every member its domain offers", () => {
    const decl = { label: "theme", domain: "theme", default: "bar" } as const;
    for (const name of placementThemeNames()) {
      expect(parseSettingSpelling(decl, name)).toBe(name);
    }
    expect(parseSettingSpelling(decl, "no-such-theme")).toBeUndefined();
  });

  test("a boolean setting spells its members as the session store does", () => {
    const decl = { label: "wrap", domain: "bool", default: true } as const;
    for (const member of BOOLEAN_MEMBERS) {
      expect(String(parseSettingSpelling(decl, member))).toBe(member);
    }
    expect(parseSettingSpelling(decl, "yes")).toBeUndefined();
  });

  test("each setting's row admits its domain and nothing else", () => {
    const { theme, style, preset, padding, effect } = TABLE.globals;
    const [installed] = listResolvablePaletteNames();
    expect(theme.parse(installed!)).toBe(installed);
    expect(theme.parse("no-such-theme")).toBeNull();
    expect(style.parse("vapor")).not.toBeNull();
    expect(style.parse("other")).toBeNull();
    // Object.prototype's keys are no declared style.
    expect(style.parse("constructor")).toBeNull();
    // The floor preset is a member, though no config declares it.
    expect(preset.parse("default")).toBe("default");
    expect(preset.parse("roomy")).toBe("roomy");
    expect(preset.parse("gone")).toBeNull();
    expect(padding.parse("16")).toBe(16);
    expect(padding.parse("99")).toBeNull();
    expect(effect.parse("glitter")).toBeNull();
    expect(sizeRow().parse("5")).toBe(5);
    expect(sizeRow().parse("9")).toBeNull();
  });

  test("every row is keyed by its session key", () => {
    for (const [key, row] of TABLE.rows) expect(row.key).toBe(key);
    expect(TABLE.rows.get(SIZE)).toBe(sizeRow());
  });
});

describe("the fold", () => {
  test("a staged value outranks a pick, stale or held", () => {
    expect(foldSetting(7, { kind: "stale", raw: "x" }, 1)).toEqual({
      value: 7,
      decidedBy: { kind: "staged" },
    });
    expect(foldSetting(7, { kind: "held", value: 4 }, 1).value).toBe(7);
  });

  test("a held pick decides; a stale one yields what lies beneath it and says so", () => {
    expect(foldSetting(undefined, { kind: "held", value: 4 }, 1)).toEqual({
      value: 4,
      decidedBy: { kind: "picked" },
    });
    expect(foldSetting(undefined, { kind: "stale", raw: "x" }, 1)).toEqual({
      value: 1,
      decidedBy: { kind: "stale", raw: "x" },
    });
    expect(foldSetting(undefined, { kind: "unset" }, 1)).toEqual({
      value: 1,
      decidedBy: { kind: "beneath" },
    });
  });

  test("a placement's stale pick folds to the placement's own value", () => {
    expect(placementFold(sizeRow(), "9")).toEqual({
      value: 3,
      decidedBy: { kind: "stale", raw: "9" },
    });
    expect(placementFold(sizeRow(), "4").value).toBe(4);
  });
});

describe("the stale warning", () => {
  const domains = () => new Map();

  test("names the setting, the spelling, what the bar wears and what it can hold, and asks for a pick", () => {
    const [warning] = staleWarnings(
      [{ row: TABLE.globals.padding, raw: "99", wears: "1" }],
      domains,
    );
    expect(warning).toEqual({
      kind: "stale",
      key: "padding",
      setting: "padding",
      message:
        'Setting padding holds "99", which it cannot hold, so the bar wears "1". ' +
        "It can hold an integer from 0 to 16. Pick it again.",
    });
  });

  test("names a retired theme's successor and never asks for a save", () => {
    const [warning] = staleWarnings(
      [{ row: TABLE.globals.theme, raw: "dark", wears: "textual-dark" }],
      domains,
    );
    expect(warning!.message).toContain(
      '"dark" was retired; write "textual-dark"',
    );
    expect(warning!.message).not.toMatch(/\bsave\b/i);
  });

  test("an uninstalled theme lists what is installed", () => {
    const [warning] = staleWarnings(
      [{ row: TABLE.globals.theme, raw: "no-such-theme", wears: "x" }],
      domains,
    );
    expect(warning!.message).toMatch(/It can hold one of \d+ values, such as /);
  });

  test("one warning per setting, however often the frame met it", () => {
    const pick = { row: sizeRow(), raw: "9", wears: "3" };
    expect(staleWarnings([pick, pick], domains)).toHaveLength(1);
    expect(staleWarnings([pick, pick], domains)[0]!.setting).toBe(
      '"size" of placement "probe"',
    );
  });
});

describe("one owner per session key", () => {
  const load = (variables: string) => () =>
    parseAndValidate(
      "<user>",
      `{
        variables: ${variables},
        segments: {
          probe: {
            template: "{{ .settings.size }}",
            settings: { size: { label: "Size", domain: { min: 0, max: 5 }, default: 1 } },
          },
        },
        root: { h: [{ seg: "probe", id: "probe" }] },
      }`,
      ALLOWED,
      DEFAULT_DSL_CONFIG,
    );

  test("a state variable over a globals setting's key is refused", () => {
    expect(load(`{ mine: { kind: "state", key: "theme" } }`)).toThrow(
      /variables\.mine: a state variable reads "theme", which is the session key of setting theme — the setting owns it; read its value from the "theme\.effective" variable/,
    );
  });

  test("one over a placement setting's key is refused as edit mode's own", () => {
    expect(load(`{ mine: { kind: "state", key: "${SIZE}" } }`)).toThrow(
      /is in the "edit\." namespace, where the bar mints its own keys/,
    );
  });

  test("a plain state key is the variable's own", () => {
    expect(load(`{ mine: { kind: "state", key: "mood" } }`)).not.toThrow();
  });
});
