// [LAW:one-source-of-truth] Direct unit coverage of the option-domain registry
// itself — resolveOptionDomain is the ONE place render/action.ts and
// daemon/verbs/state-validators.ts resolve a `from` value, so its contract
// (inline arrays are self-resolving, named domains check per-config overrides
// before the global registry, unknown names throw naming what IS known,
// built-ins can never be reclaimed) is pinned here rather than only exercised
// incidentally through the config pipeline (test/dsl-actions.test.ts covers
// that end-to-end acceptance).

import {
  knownOptionDomainNames,
  perConfigDomainsFor,
  registerOptionDomain,
  resolveOptionDomain,
} from "../src/config/option-domain";
import {
  paletteForThemeName,
  transposedPalette,
} from "../src/themes/palette-resolvers";
import {
  CHARSETS,
  COLOR_COMPATIBILITIES,
  listResolvablePaletteNames,
  STRIP_STYLES,
} from "../src/themes/policy";

describe("option-domain registry", () => {
  test("themes/styles are built-in registrations, not special-cased branches", () => {
    expect(resolveOptionDomain("themes", new Map()).members).toEqual(
      listResolvablePaletteNames(),
    );
    expect(resolveOptionDomain("styles", new Map()).members).toEqual(STRIP_STYLES);
  });

  // [LAW:one-source-of-truth] candybar-config-engine-71o.3: charsets/
  // colorCompatibilities must resolve to the EXACT same consts the loader's
  // own globals.charset/globals.colorCompatibility field validation checks
  // against (themes/policy.ts) — a menu drawing from these can never
  // enumerate a value the loader or the render layer would reject.
  test("charsets/colorCompatibilities are built-in registrations sourced from the loader's own enums", () => {
    expect(resolveOptionDomain("charsets", new Map()).members).toEqual(CHARSETS);
    expect(resolveOptionDomain("colorCompatibilities", new Map()).members).toEqual(
      COLOR_COMPATIBILITIES,
    );
  });

  test("an inline array IS its own domain — no registry lookup", () => {
    expect(resolveOptionDomain(["a", "b", "c"], new Map()).members).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("a per-config domain (e.g. looks) resolves from the caller's map, not the global registry", () => {
    const perConfig = new Map([["looks", { members: ["vapor", "none"] }]]);
    expect(resolveOptionDomain("looks", perConfig).members).toEqual([
      "vapor",
      "none",
    ]);
  });

  test("a per-config entry takes precedence over a same-named global registration", () => {
    const dispose = registerOptionDomain("shadowed", () => ["global"]);
    try {
      const perConfig = new Map([["shadowed", { members: ["local"] }]]);
      expect(resolveOptionDomain("shadowed", perConfig).members).toEqual([
        "local",
      ]);
    } finally {
      dispose();
    }
  });

  test("registerOptionDomain adds a resolvable domain and its disposer removes it", () => {
    const dispose = registerOptionDomain("custom-71o", () => ["x", "y"]);
    expect(resolveOptionDomain("custom-71o", new Map()).members).toEqual([
      "x",
      "y",
    ]);
    dispose();
    expect(() => resolveOptionDomain("custom-71o", new Map())).toThrow(
      /unknown option domain "custom-71o"/,
    );
  });

  test("an unknown domain name throws naming the known set", () => {
    expect(() => resolveOptionDomain("bogus", new Map())).toThrow(
      /unknown option domain "bogus" \(have: .*themes.*styles.*\)/,
    );
  });

  test("a built-in domain name can never be reclaimed", () => {
    expect(() => registerOptionDomain("themes", () => ["x"])).toThrow(
      /already registered.*built-in/,
    );
    expect(() => registerOptionDomain("styles", () => ["x"])).toThrow(
      /already registered.*built-in/,
    );
  });

  test("registering the same name twice (both non-built-in) throws, without a built-in mention", () => {
    const dispose = registerOptionDomain("dup-71o", () => ["x"]);
    try {
      expect(() => registerOptionDomain("dup-71o", () => ["y"])).toThrow(
        /already registered/,
      );
      expect(() => registerOptionDomain("dup-71o", () => ["y"])).not.toThrow(
        /built-in/,
      );
    } finally {
      dispose();
    }
  });

  test("a disposer is idempotent — calling it twice does not throw or double-remove another registration", () => {
    const dispose = registerOptionDomain("idempotent-71o", () => ["x"]);
    dispose();
    expect(() => dispose()).not.toThrow();
    // Re-registering after disposal succeeds — the slot is genuinely free.
    const dispose2 = registerOptionDomain("idempotent-71o", () => ["y"]);
    expect(resolveOptionDomain("idempotent-71o", new Map()).members).toEqual([
      "y",
    ]);
    dispose2();
  });

  test("knownOptionDomainNames unions the global registry with per-config overrides", () => {
    const perConfig = new Map([["looks", { members: ["none"] }]]);
    const names = knownOptionDomainNames(perConfig);
    expect(names).toEqual(
      expect.arrayContaining(["themes", "styles", "looks"]),
    );
  });
});

// brandon-picker-31z: a registration carries BOTH facets of its domain — the
// members, and (when the domain is colour-valued) the palette that picking a
// member would put in force. They resolve together from one entry, which is what
// stops a colour-valued domain from existing for the click gate but not the
// render.
describe("a colour-valued domain resolves its own painter", () => {
  const BASE = paletteForThemeName("textual-dark");

  test("`themes` answers with that theme's own palette, through the one name -> Palette enforcer", () => {
    const { members, paletteOf } = resolveOptionDomain("themes", new Map());
    expect(paletteOf).toBeDefined();
    for (const name of members) {
      // Identity, not just equality: paletteForThemeName memoizes per resolved
      // name, so the painter must BE that memo rather than a second construction.
      expect(paletteOf!(name, BASE)).toBe(paletteForThemeName(name));
    }
  });

  test("`themes` ignores the base it is handed — a theme is not an adaptation of anything", () => {
    const { members, paletteOf } = resolveOptionDomain("themes", new Map());
    const [first, second] = members as [string, string];
    expect(paletteOf!(first, BASE)).toBe(
      paletteOf!(first, paletteForThemeName(second)),
    );
  });

  test("`looks` answers with the BASE transposed by that look's ThemeKey", () => {
    const looks = {
      none: {
        hueShift: 0,
        chromaScale: 1,
        lightnessScale: 1,
        lightnessShift: 0,
      },
      dim: {
        hueShift: 0,
        chromaScale: 1,
        lightnessScale: 0.7,
        lightnessShift: 0,
      },
    };
    const domains = perConfigDomainsFor({ looks, presets: {} });
    const { members, paletteOf } = resolveOptionDomain("looks", domains);
    expect(members).toEqual(["none", "dim"]);
    expect(paletteOf!("dim", BASE)).toBe(transposedPalette(BASE, looks.dim));
    // The identity key is byte-exact through transposePalette's fast path, so
    // the floor answers with the base itself — the honest "picking this changes
    // nothing".
    expect(paletteOf!("none", BASE)).toBe(transposedPalette(BASE, looks.none));
  });

  test("every domain whose members are not colours has no painter", () => {
    const domains = perConfigDomainsFor({
      looks: {},
      presets: { compact: {} },
    });
    for (const name of ["styles", "charsets", "colorCompatibilities"]) {
      expect(resolveOptionDomain(name, new Map()).paletteOf).toBeUndefined();
    }
    expect(resolveOptionDomain("presets", domains).paletteOf).toBeUndefined();
    // An inline array is its own domain — a bare list of words, so it is
    // structurally incapable of being colour-valued.
    expect(resolveOptionDomain(["a", "b"], new Map()).paletteOf).toBeUndefined();
  });

  test("a custom registration may declare a painter, and the disposer takes it with the domain", () => {
    const dispose = registerOptionDomain(
      "painted-31z",
      () => ["one"],
      () => BASE,
    );
    try {
      expect(resolveOptionDomain("painted-31z", new Map()).paletteOf!("one", BASE)).toBe(BASE);
    } finally {
      dispose();
    }
    expect(() => resolveOptionDomain("painted-31z", new Map())).toThrow(
      /unknown option domain "painted-31z"/,
    );
  });
});
