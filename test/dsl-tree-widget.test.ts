// [LAW:verifiable-goals] 2de.3 acceptance — the `tree` widget (the OUTLINE
// projection of the menu) driven through the REAL spine (registerDslConfig +
// renderDsl), the REAL loader (parseAndValidate), and the REAL derived-validator
// path. The verifiable claims from the ticket:
//
//   1. enumerateOpenPaths — the canonical open-state value set (closed, open-
//      root, one path per submenu; leaves contribute none; nested).
//   2. A raw tree config loads; a submenu without identity / with onClick is
//      rejected at load (the recursive item walk).
//   3. The open-path key gets an allow-list validator DERIVED from the tree, so
//      the wire accepts exactly the renderer's writes (closed/open-root/paths).
//   4. Render: closed shows only the toggle; open shows the toggle + top level;
//      a submenu opens its children on their OWN line (the "\n" → split lines
//      primitive); a leaf click fires its action and leaves the menu OPEN; ✕
//      closes; the chevron flips by open-state; accordion (one path per branch).

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { effectsOf } from "./helpers/click";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  enumerateOpenPaths,
  MENU_CLOSED,
  MENU_OPEN_ROOT,
} from "../src/config/widget";
import {
  ConfigError,
  parseDslConfig,
  mergeWithDefault,
  validateConfig,
} from "../src/config/dsl-loader";
import {
  deriveWidgetValidators,
  registerStateValidator,
  validateStateWrite,
} from "../src/daemon/verbs/state-validators";

const ALLOWED = new Set(listResolvablePaletteNames());

function opts(width: number) {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    width,
  };
}

const URL_RE = /\x1b\]8;;([^\x1b]+)\x1b\\/g; // eslint-disable-line no-control-regex
function extractUrls(rendered: string): string[] {
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function buildRuntime(src: string, sessionId = "s1") {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { store });
  const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
  const render = (width: number): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: sessionId },
      basePalette,
      opts(width),
    );
  return { config, store, registry, sessionState, render };
}

function expectError(source: string): ConfigError {
  try {
    parseAndValidate("<test>", source, ALLOWED);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("expected ConfigError, got success");
}

// A representative raw tree: two top-level submenus + a top-level leaf; one
// submenu nests another (Actions → Deep). Indices:
//   [0] Themes (submenu) → "0"        children: an options picker (leaf)
//   [1] Actions (submenu) → "1"       children: [0] Copy (leaf), [1] Deep (sub)
//   [1][1] Deep (submenu) → "1.1"     children: [0] X (leaf)
//   [2] Quit (leaf)                   (no path — leaves never open)
const TREE_SRC = `{
  globals: { palette: 'textual-dark' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
    theme: { kind: 'state', key: 'theme', default: 'textual-dark' },
    menuPath: { kind: 'state', key: 'menu-path', default: '${MENU_CLOSED}' },
  },
  widgets: {
    nav: {
      kind: 'tree',
      state: 'menu-path',
      items: [
        { label: 'Themes', items: [
          { optionsFrom: 'themes', onClick: { set: 'theme' } },
        ] },
        { label: 'Actions', items: [
          { label: 'Copy', onClick: { copy: '{{ .session.id }}' } },
          { label: 'Deep', items: [
            { label: 'X', onClick: { copy: 'x' } },
          ] },
        ] },
        { glyph: '⏻', label: 'Quit', onClick: { copy: 'q' } },
      ],
    },
  },
  segments: {
    nav: { template: '{{ widget "nav" }}', bg: 'surface', fg: 'foreground' },
  },
  layout: [['nav']],
}`;

// ─── enumerateOpenPaths ──────────────────────────────────────────────────────

describe("2de.3 — enumerateOpenPaths", () => {
  test("closed + open-root + one path per submenu; leaves contribute none", () => {
    const config = parseAndValidate("<test>", TREE_SRC, ALLOWED);
    const tree = config.widgets.nav;
    if (!tree || tree.kind !== "tree") throw new Error("expected a tree widget");
    expect(enumerateOpenPaths(tree.items)).toEqual([
      MENU_CLOSED,
      MENU_OPEN_ROOT,
      "0",
      "1",
      "1.1",
    ]);
  });

  test("a flat tree of only leaves yields just closed + open-root", () => {
    expect(
      enumerateOpenPaths([
        { onClick: [{ copy: "a" }] },
        { onClick: [{ copy: "b" }] },
      ]),
    ).toEqual([MENU_CLOSED, MENU_OPEN_ROOT]);
  });
});

// ─── Loader: the recursive item walk ─────────────────────────────────────────

describe("2de.3 — loader (tree validation)", () => {
  test("a valid raw tree loads, preserving the recursive structure", () => {
    const config = parseAndValidate("<test>", TREE_SRC, ALLOWED);
    const tree = config.widgets.nav;
    if (!tree || tree.kind !== "tree") throw new Error("expected a tree widget");
    expect(tree.state).toBe("menu-path");
    expect(tree.items).toHaveLength(3);
    // [1] Actions is a submenu whose [1] Deep is also a submenu.
    const actions = tree.items[1];
    if (!actions || !("items" in actions)) throw new Error("expected a submenu");
    expect(actions.items).toHaveLength(2);
    expect("items" in actions.items[1]!).toBe(true); // Deep nests
  });

  test("a submenu with neither glyph nor label is rejected", () => {
    const err = expectError(`{
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      widgets: { m: { kind: 'tree', state: 'p', items: [ { items: [ { label: 'x', onClick: { copy: 'y' } } ] } ] } },
      segments: { s: { template: '{{ widget "m" }}' } },
      layout: [['s']],
    }`);
    expect(err.issues.some((i) => /non-empty "glyph" or "label"/.test(i.message))).toBe(true);
  });

  test("a submenu carrying onClick is rejected (no author-bound toggle)", () => {
    const err = expectError(`{
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      widgets: { m: { kind: 'tree', state: 'p', items: [ { label: 'S', onClick: { copy: 'z' }, items: [ { label: 'x', onClick: { copy: 'y' } } ] } ] } },
      segments: { s: { template: '{{ widget "m" }}' } },
      layout: [['s']],
    }`);
    expect(err.issues.some((i) => /Unknown submenu key "onClick"/.test(i.message))).toBe(true);
  });

  test("a tree without its open-path state key is rejected", () => {
    const err = expectError(`{
      widgets: { m: { kind: 'tree', items: [ { label: 'x', onClick: { copy: 'y' } } ] } },
      segments: { s: { template: '{{ widget "m" }}' } },
      layout: [['s']],
    }`);
    expect(err.issues.some((i) => /must declare a non-empty "state"/.test(i.message))).toBe(true);
  });
});

// ─── Derived open-path validator ─────────────────────────────────────────────

describe("2de.3 — derived open-path validator", () => {
  test("the open-path key derives an allow-list of exactly the enumerated paths", () => {
    const config = parseAndValidate("<test>", TREE_SRC, ALLOWED);
    const derived = deriveWidgetValidators(config);
    const entry = derived.find((d) => d.key === "menu-path");
    expect(entry?.spec).toEqual({
      kind: "allow-list",
      allowed: [MENU_CLOSED, MENU_OPEN_ROOT, "0", "1", "1.1"],
    });
  });

  test("the wire gate accepts the renderer's writes and rejects everything else", () => {
    const config = parseAndValidate("<test>", TREE_SRC, ALLOWED);
    const dispose = deriveWidgetValidators(config).map((d) =>
      registerStateValidator(d.key, d.spec),
    );
    try {
      for (const ok of [MENU_CLOSED, MENU_OPEN_ROOT, "0", "1", "1.1"]) {
        expect(validateStateWrite("menu-path", ok).ok).toBe(true);
      }
      // a non-enumerated path (no such submenu) is rejected
      expect(validateStateWrite("menu-path", "2").ok).toBe(false);
      expect(validateStateWrite("menu-path", "0.0").ok).toBe(false);
    } finally {
      dispose.forEach((d) => d());
    }
  });
});

// ─── Render: the outline projection ──────────────────────────────────────────

describe("2de.3 — render (outline projection)", () => {
  test("closed: one line, only the toggle, linking to open-root", () => {
    const { render } = buildRuntime(TREE_SRC); // default menu-path = closed
    const out = render(80);
    expect(out.includes("\n")).toBe(false);
    expect(stripAnsi(out)).toContain("☰");
    expect(stripAnsi(out)).not.toContain("✕");
    const urls = extractUrls(out);
    expect(urls).toHaveLength(1);
    expect(effectsOf(urls[0]!)).toEqual([
      { verb: "set-state", args: ["s1", "menu-path", MENU_OPEN_ROOT] },
    ]);
  });

  test("open-root: ✕ + top level; submenu chevrons closed; leaf fires its own action", () => {
    const { render, sessionState } = buildRuntime(TREE_SRC);
    sessionState.set("s1", "menu-path", MENU_OPEN_ROOT);
    const out = render(Number.POSITIVE_INFINITY);
    expect(out.includes("\n")).toBe(false); // only the top level shows
    const plain = stripAnsi(out);
    expect(plain).toContain("✕");
    expect(plain).toContain("▸ Themes");
    expect(plain).toContain("▸ Actions");
    expect(plain).toContain("Quit");
    const byTarget = (key: string, val: string) =>
      extractUrls(out).map(effectsOf).some((effs) =>
        effs.some((e) => e.verb === "set-state" && e.args[1] === key && e.args[2] === val),
      );
    expect(byTarget("menu-path", MENU_CLOSED)).toBe(true); // ✕ closes
    expect(byTarget("menu-path", "0")).toBe(true); // Themes opens to its path
    expect(byTarget("menu-path", "1")).toBe(true); // Actions opens to its path
    // the Quit leaf is a copy — it writes NO open-path key (menu stays open)
    const quitUrl = extractUrls(out)
      .map(effectsOf)
      .find((effs) => effs.some((e) => e.verb === "copy" && e.args[0] === "q"));
    expect(quitUrl).toEqual([{ verb: "copy", args: ["q"] }]);
  });

  test("expanded: a submenu's children render on their OWN line, chevron flips, leaf stays open", () => {
    const { render, sessionState } = buildRuntime(TREE_SRC);
    sessionState.set("s1", "menu-path", "0"); // Themes open
    const out = render(Number.POSITIVE_INFINITY);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2); // top level + Themes' children
    expect(stripAnsi(lines[0]!)).toContain("▾ Themes"); // open chevron
    expect(stripAnsi(lines[0]!)).toContain("▸ Actions"); // sibling stays closed (accordion)
    // line 1 carries the theme options; each click APPLIES a theme and writes
    // NO open-path key — the menu stays open after a leaf click.
    const themeEffs = extractUrls(lines[1]!).map(effectsOf);
    expect(themeEffs.length).toBeGreaterThan(0);
    for (const effs of themeEffs) {
      expect(effs).toHaveLength(1);
      expect(effs[0]!.verb).toBe("set-state");
      expect(effs[0]!.args[1]).toBe("theme");
      expect(effs[0]!.args).not.toContain("menu-path");
    }
    // the OPEN Themes chevron collapses to its parent (open-root)
    const collapses = extractUrls(lines[0]!).map(effectsOf).some((effs) =>
      effs.some((e) => e.args[1] === "menu-path" && e.args[2] === MENU_OPEN_ROOT),
    );
    expect(collapses).toBe(true);
  });

  test("accordion: with one branch open, a sibling submenu click switches the path (not adds)", () => {
    const { render, sessionState } = buildRuntime(TREE_SRC);
    sessionState.set("s1", "menu-path", "0"); // Themes open
    const out = render(Number.POSITIVE_INFINITY);
    // The closed sibling Actions targets its OWN path "1" — opening it replaces
    // the open path, so Themes closes (one path per branch).
    const actionsOpens = extractUrls(out).map(effectsOf).some((effs) =>
      effs.some((e) => e.args[1] === "menu-path" && e.args[2] === "1"),
    );
    expect(actionsOpens).toBe(true);
  });

  test("nested: a deep path renders one line per level, deepest chevron open", () => {
    const { render, sessionState } = buildRuntime(TREE_SRC);
    sessionState.set("s1", "menu-path", "1.1"); // Actions → Deep open
    const out = render(Number.POSITIVE_INFINITY);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3); // top + Actions' children + Deep's children
    expect(stripAnsi(lines[0]!)).toContain("▾ Actions");
    expect(stripAnsi(lines[1]!)).toContain("▾ Deep");
    expect(stripAnsi(lines[2]!)).toContain("X"); // Deep's leaf
  });

  test("a non-canonical stored open-path collapses to closed (parse = inverse of enumerate)", () => {
    // [LAW:one-source-of-truth] "01"/"1abc" would be loosely read as index 1 by
    // parseInt, but the derived allow-list gate (openPathToString outputs) never
    // emits them — the renderer must NOT treat them as open, or its understood
    // set would diverge from the wire's accepted set.
    for (const stale of ["01", "1abc", " 1", "-1", "0.01"]) {
      const { render, sessionState } = buildRuntime(TREE_SRC);
      sessionState.set("s1", "menu-path", stale);
      const out = render(Number.POSITIVE_INFINITY);
      expect(out.includes("\n")).toBe(false); // closed = a single toggle line
      expect(stripAnsi(out)).toContain("☰");
      expect(stripAnsi(out)).not.toContain("✕");
    }
  });
});
