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
  registerOptionDomain,
  resolveOptionDomain,
} from "../src/config/option-domain";
import { listResolvablePaletteNames, STRIP_STYLES } from "../src/themes/policy";

describe("option-domain registry", () => {
  test("themes/styles are built-in registrations, not special-cased branches", () => {
    expect(resolveOptionDomain("themes", new Map())).toEqual(
      listResolvablePaletteNames(),
    );
    expect(resolveOptionDomain("styles", new Map())).toEqual(STRIP_STYLES);
  });

  test("an inline array IS its own domain — no registry lookup", () => {
    expect(resolveOptionDomain(["a", "b", "c"], new Map())).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("a per-config domain (e.g. looks) resolves from the caller's map, not the global registry", () => {
    const perConfig = new Map([["looks", ["vapor", "none"]]]);
    expect(resolveOptionDomain("looks", perConfig)).toEqual([
      "vapor",
      "none",
    ]);
  });

  test("a per-config entry takes precedence over a same-named global registration", () => {
    const dispose = registerOptionDomain("shadowed", () => ["global"]);
    try {
      const perConfig = new Map([["shadowed", ["local"]]]);
      expect(resolveOptionDomain("shadowed", perConfig)).toEqual(["local"]);
    } finally {
      dispose();
    }
  });

  test("registerOptionDomain adds a resolvable domain and its disposer removes it", () => {
    const dispose = registerOptionDomain("custom-71o", () => ["x", "y"]);
    expect(resolveOptionDomain("custom-71o", new Map())).toEqual(["x", "y"]);
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
    expect(resolveOptionDomain("idempotent-71o", new Map())).toEqual(["y"]);
    dispose2();
  });

  test("knownOptionDomainNames unions the global registry with per-config overrides", () => {
    const perConfig = new Map([["looks", ["none"]]]);
    const names = knownOptionDomainNames(perConfig);
    expect(names).toEqual(
      expect.arrayContaining(["themes", "styles", "looks"]),
    );
  });
});
