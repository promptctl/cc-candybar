// [LAW:verifiable-goals] 2de.5 (S1) acceptance, driven through the REAL spine
// (registerDslConfig + renderDsl), the REAL loader (parseAndValidate), and the
// REAL set-state gate (deriveNodeValidators / deriveValidators +
// registerStateValidator + validateStateWrite) — never a parallel rig:
//
//   1. A raw `root` config authors an inline-cells leaf carrying a clickable
//      cell whose `onClick` is a structured (key, value) SessionState write. It
//      renders as an OSC-8 `set-state` link the click wire round-trips.
//   2. deriveNodeValidators DERIVES the gate from that same (key, value): an
//      allow-list whose member is the literal `to`. The rendered click IS the
//      gate — they cannot diverge.
//   3. End-to-end: clicking the cell writes SessionState through the derived
//      gate; a `when`-gated reveal node (the mirror of onClick — it READS the
//      same key) becomes visible on the next render. onClick writes, when reads.
//   4. The open-trigger pattern: an inline cell writing "0" to a key a menu
//      widget declares `int` MERGES (deriveValidators) instead of colliding —
//      mergeKeySpecs absorbs the integer allow-list member into the int gate.

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  deriveNodeValidators,
  deriveValidators,
  registerStateValidator,
  validateStateWrite,
} from "../src/daemon/verbs/state-validators";
import { effectsOf } from "./helpers/click";

const ALLOWED = new Set(listResolvablePaletteNames());

function opts(width: number) {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    width,
  };
}

function extractUrls(rendered: string): string[] {
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

// A raw `root` config: an inline trigger cell ("▸") whose click opens a panel
// (writes theme-page=0), and a reveal row gated on that same key. No widgets —
// the trigger is a pure substrate onClick cell, the reveal a pure `when`.
const SRC = `{
  globals: { palette: 'textual-dark' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    themePage: { kind: 'state', key: 'theme-page', default: '-1' },
  },
  segments: {
    panel: { template: ' PANEL ', bg: 'surface', fg: 'foreground' },
  },
  root: {
    kind: 'container',
    direction: 'vertical',
    children: [
      {
        kind: 'inline',
        bg: 'surface',
        fg: 'foreground',
        cells: [{ text: '▸', onClick: { set: 'theme-page', to: '0' } }],
      },
      {
        kind: 'cells',
        when: '{{ ge (int .themePage) 0 }}',
        segments: ['panel'],
      },
    ],
  },
}`;

function buildRuntime(src: string, sessionId = "s1") {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { store });
  const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
  const render = (width = Number.POSITIVE_INFINITY): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: sessionId },
      basePalette,
      opts(width),
    );
  // The REAL set-state gate the daemon installs from the config (both surfaces).
  const disposers = deriveValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  // [LAW:single-enforcer] Apply a set-state click exactly as the verb does:
  // validate through the derived gate, then write the canonical value.
  const click = (url: string): void => {
    for (const { verb, args } of effectsOf(url)) {
      if (verb !== "set-state") throw new Error(`unexpected click verb ${verb}`);
      const [sid, ...pairs] = args;
      for (let i = 0; i < pairs.length; i += 2) {
        const result = validateStateWrite(pairs[i]!, pairs[i + 1]!);
        if (!result.ok) throw new Error(`click rejected: ${result.reason}`);
        sessionState.set(sid!, pairs[i]!, result.value);
      }
    }
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return { config, store, registry, sessionState, render, click, dispose };
}

describe("2de.5 — inline-cell onClick end-to-end", () => {
  test("an inline cell renders its text as an OSC-8 set-state link", () => {
    const rt = buildRuntime(SRC);
    try {
      const out = rt.render();
      expect(stripAnsi(out)).toContain("▸");
      const urls = extractUrls(out);
      expect(urls).toHaveLength(1);
      // The structured (key, value) round-trips through the real wire as one
      // set-state effect carrying [sessionId, key, value].
      expect(effectsOf(urls[0]!)).toEqual([
        { verb: "set-state", args: ["s1", "theme-page", "0"] },
      ]);
    } finally {
      rt.dispose();
    }
  });

  test("deriveNodeValidators derives an allow-list gate from the onClick", () => {
    const rt = buildRuntime(SRC);
    try {
      expect(deriveNodeValidators(rt.config)).toEqual([
        { key: "theme-page", spec: { kind: "allow-list", allowed: ["0"] } },
      ]);
    } finally {
      rt.dispose();
    }
  });

  test("clicking the cell writes state through the gate; a when-gated reveal appears", () => {
    const rt = buildRuntime(SRC);
    try {
      // Closed: theme-page default -1, so the reveal is absent (no PANEL).
      const before = rt.render();
      expect(stripAnsi(before)).not.toContain("PANEL");

      // Click the trigger — drives the real gate + state write.
      const url = extractUrls(before)[0]!;
      rt.click(url);

      // Open: the reveal node's `when` reads the same key the click wrote.
      const after = rt.render();
      expect(stripAnsi(after)).toContain("PANEL");
    } finally {
      rt.dispose();
    }
  });

  test("a non-writable wire value is rejected by the derived gate", () => {
    const rt = buildRuntime(SRC);
    try {
      expect(validateStateWrite("theme-page", "0").ok).toBe(true);
      // The allow-list gate accepts only the declared "0".
      const bad = validateStateWrite("theme-page", "9");
      expect(bad.ok).toBe(false);
    } finally {
      rt.dispose();
    }
  });
});

// ─── Open-trigger merge: an inline cell + a menu widget on one key ──────────────

// The live-config shape: a trigger cell opens a menu by writing its int page key,
// while the menu widget declares that same key `int`. The two surfaces must
// MERGE (one int gate that absorbs the "0") rather than collide on kind.
const OPEN_TRIGGER_SRC = `{
  globals: { palette: 'textual-dark' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    'term.cols': { kind: 'input', path: 'term.cols', type: 'number' },
    themePage: { kind: 'state', key: 'theme-page', default: '-1' },
  },
  widgets: {
    themeMenu: {
      kind: 'menu',
      state: 'theme-page',
      items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }],
    },
  },
  segments: {
    picker: { template: '{{ widget "themeMenu" }}', bg: 'surface', fg: 'foreground' },
  },
  root: {
    kind: 'container',
    direction: 'vertical',
    children: [
      {
        kind: 'inline',
        bg: 'surface',
        fg: 'foreground',
        cells: [{ text: '▸', onClick: { set: 'theme-page', to: '0' } }],
      },
      {
        kind: 'cells',
        when: '{{ ge (int .themePage) 0 }}',
        segments: ['picker'],
      },
    ],
  },
}`;

describe("2de.5 — cross-source validator merge (open-trigger pattern)", () => {
  test("deriveValidators merges the inline allow-list into the menu int gate", () => {
    const config = parseAndValidate("<test>", OPEN_TRIGGER_SRC, ALLOWED);
    // One coherence merge collapses [int (menu), allow-list "0" (cell)] → int.
    expect(deriveValidators(config)).toEqual([
      { key: "theme-page", spec: { kind: "int" } },
    ]);
  });

  test("registering the merged gate accepts both the trigger's 0 and arbitrary pages", () => {
    const config = parseAndValidate("<test>", OPEN_TRIGGER_SRC, ALLOWED);
    const disposers = deriveValidators(config).map(({ key, spec }) =>
      registerStateValidator(key, spec),
    );
    try {
      // The int gate accepts the trigger's "0" AND any other page index.
      expect(validateStateWrite("theme-page", "0").ok).toBe(true);
      expect(validateStateWrite("theme-page", "3").ok).toBe(true);
      expect(validateStateWrite("theme-page", "-1").ok).toBe(true);
      expect(validateStateWrite("theme-page", "x").ok).toBe(false);
    } finally {
      disposers.forEach((d) => d());
    }
  });
});

// ─── Loader: the onClick shape is enforced ──────────────────────────────────────

describe("2de.5 — loader rejects a malformed inline onClick", () => {
  const base = (cell: string) => `{
    globals: { palette: 'textual-dark' },
    root: {
      kind: 'inline',
      cells: [${cell}],
    },
  }`;

  test("onClick missing 'to' is rejected", () => {
    expect(() =>
      parseAndValidate("<test>", base(`{ text: 'x', onClick: { set: 'k' } }`), ALLOWED),
    ).toThrow(/to/);
  });

  test("onClick missing 'set' is rejected", () => {
    expect(() =>
      parseAndValidate("<test>", base(`{ text: 'x', onClick: { to: '0' } }`), ALLOWED),
    ).toThrow(/set/);
  });

  test("a cell without text is rejected", () => {
    expect(() =>
      parseAndValidate("<test>", base(`{ onClick: { set: 'k', to: '0' } }`), ALLOWED),
    ).toThrow(/text/);
  });

  // [LAW:verifiable-goals] The set-state wire constraints (slash-free key/value,
  // non-empty value) are surfaced at the node path at LOAD, not at a later
  // cache-install throw — mirroring the widget set-action's `to` check.
  test("an onClick with an empty 'to' is rejected at load", () => {
    expect(() =>
      parseAndValidate("<test>", base(`{ text: 'x', onClick: { set: 'k', to: '' } }`), ALLOWED),
    ).toThrow(/non-empty/);
  });

  test("a slash-bearing onClick key is rejected at load", () => {
    expect(() =>
      parseAndValidate("<test>", base(`{ text: 'x', onClick: { set: 'a/b', to: '0' } }`), ALLOWED),
    ).toThrow(/slash-free/);
  });

  test("a slash-bearing onClick value is rejected at load", () => {
    expect(() =>
      parseAndValidate("<test>", base(`{ text: 'x', onClick: { set: 'k', to: 'a/b' } }`), ALLOWED),
    ).toThrow(/slash-free/);
  });
});

describe("2de.5 — inline onClick requires session.id (the set-state wire needs it)", () => {
  test("a config with an inline onClick but no global session.id is rejected", () => {
    const src = `{
      globals: { palette: 'textual-dark' },
      root: { kind: 'inline', cells: [{ text: 'x', onClick: { set: 'k', to: 'v' } }] },
    }`;
    expect(() => parseAndValidate("<test>", src, ALLOWED)).toThrow(/session\.id/);
  });

  test("a clickless inline leaf needs no session.id", () => {
    const src = `{
      globals: { palette: 'textual-dark' },
      root: { kind: 'inline', cells: [{ text: 'plain' }] },
    }`;
    expect(() => parseAndValidate("<test>", src, ALLOWED)).not.toThrow();
  });
});

describe("2de.5 — inline bg/fg are template surfaces (refs validated like a segment's)", () => {
  test("an inline bg referencing an undeclared variable is rejected at load", () => {
    const src = `{
      globals: { palette: 'textual-dark' },
      root: { kind: 'inline', bg: '{{ .nope }}', cells: [{ text: 'x' }] },
    }`;
    expect(() => parseAndValidate("<test>", src, ALLOWED)).toThrow(/nope/);
  });
});
