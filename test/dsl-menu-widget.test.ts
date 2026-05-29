// [LAW:verifiable-goals] k5a.6 acceptance, driven through the real spine
// (registerDslConfig + renderDsl) and the real loader (parseAndValidate):
//
//   1. Width injection — renderDsl exposes opts.width as `.term.cols`, the same
//      number FlexStrip wraps to; never cached, re-read every render.
//   2. Row-level `when` — a row is a pure function of state; a hidden row does
//      not exist (no blank line), and visible rows keep positionally-stable hue.
//   3. The `menu` widget — a width-paginated option run with derived ←/→/✕
//      affordances; option clicks apply-and-close via the batched set-state wire.
//   4. paginate() — the pure pagination function in isolation.
//   5. The menu's page key gets an integer validator DERIVED from the widget.

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { paginate } from "../src/template-engine/widgets";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  makeIntValidator,
  deriveWidgetValidators,
} from "../src/daemon/verbs/state-validators";

const ALLOWED = new Set(listResolvablePaletteNames());

function opts(width: number) {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    width,
  };
}

// Extract the non-empty OSC-8 OPEN urls (the close sequence carries "").
function extractUrls(rendered: string): string[] {
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
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

// ─── Pillar 1: width injection ───────────────────────────────────────────────

describe("k5a.6 — width injection (term.cols)", () => {
  const SRC = `{
    globals: { palette: 'textual-dark' },
    variables: {
      'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
    },
    segments: { w: { template: 'cols={{ .term.cols }}', bg: 'surface', fg: 'foreground' } },
    layout: [['w']],
  }`;

  test("renderDsl exposes opts.width as .term.cols", () => {
    const { render } = buildRuntime(SRC);
    expect(stripAnsi(render(137))).toContain("cols=137");
  });

  test("a resize is just a new value on the same path (never cached)", () => {
    const { render } = buildRuntime(SRC);
    expect(stripAnsi(render(100))).toContain("cols=100");
    // Re-render at a different width with NO reload — the value must update.
    expect(stripAnsi(render(42))).toContain("cols=42");
  });
});

// ─── Pillar 2: row-level when ────────────────────────────────────────────────

describe("k5a.6 — row-level when", () => {
  const SRC = `{
    globals: { palette: 'textual-dark' },
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      open: { kind: 'state', key: 'open', default: '0' },
    },
    segments: {
      top: { template: 'TOP', bg: 'surface', fg: 'foreground' },
      bot: { template: 'BOT', bg: 'surface', fg: 'foreground' },
    },
    layout: [
      ['top'],
      { when: '{{ eq .open "1" }}', segments: ['bot'] },
    ],
  }`;

  test("a false-when row does not exist — no blank line", () => {
    const { render } = buildRuntime(SRC);
    const out = render(80);
    expect(out.includes("\n")).toBe(false); // single line, not "TOP\n"
    expect(stripAnsi(out)).toContain("TOP");
    expect(stripAnsi(out)).not.toContain("BOT");
  });

  test("a true-when row renders as a real second line", () => {
    const { render, sessionState } = buildRuntime(SRC);
    sessionState.set("s1", "open", "1");
    const out = render(80);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(stripAnsi(lines[1]!)).toContain("BOT");
  });
});

// ─── paginate (pure) ─────────────────────────────────────────────────────────

describe("k5a.6 — paginate()", () => {
  test("everything fits → one page", () => {
    expect(paginate([3, 3, 3], 100, 0)).toEqual([[0, 1, 2]]);
  });

  test("overflow splits into pages, reserving arrow space", () => {
    // usable = 20 - 6 = 14. items width 6 each + 1 separator = 6,13,20→split.
    expect(paginate([6, 6, 6], 20, 6)).toEqual([[0, 1], [2]]);
  });

  test("an oversized lone item gets its own page (cannot be split)", () => {
    expect(paginate([50, 4], 20, 0)).toEqual([[0], [1]]);
  });

  test("infinite width collapses to one page", () => {
    expect(paginate([10, 10, 10], Number.POSITIVE_INFINITY, 6)).toEqual([
      [0, 1, 2],
    ]);
  });

  test("empty input → no pages", () => {
    expect(paginate([], 80, 6)).toEqual([]);
  });
});

// ─── Pillar 3: the menu widget ───────────────────────────────────────────────

const MENU_SRC = `{
  globals: { palette: 'textual-dark' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
    theme: { kind: 'state', key: 'theme', default: 'textual-dark' },
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
    trigger: { template: 'T', bg: 'surface', fg: 'foreground' },
    menu: { template: '{{ widget "themeMenu" }}', bg: 'surface', fg: 'foreground' },
  },
  layout: [
    ['trigger'],
    { when: '{{ ge (int .themePage) 0 }}', segments: ['menu'] },
  ],
}`;

describe("k5a.6 — menu widget", () => {
  test("closed (page -1): the menu row does not render", () => {
    const { render } = buildRuntime(MENU_SRC);
    const out = render(80);
    expect(out.includes("\n")).toBe(false);
    expect(extractUrls(out)).toEqual([]); // no clickable affordances
  });

  test("open at a wide width: every option, no arrows, one close ✕", () => {
    const { render, sessionState } = buildRuntime(MENU_SRC);
    sessionState.set("s1", "theme-page", "0");
    const out = render(Number.POSITIVE_INFINITY);
    const line = out.split("\n")[1]!;
    const urls = extractUrls(line);
    const themeCount = listResolvablePaletteNames().length;
    // close + one per theme
    expect(urls).toHaveLength(themeCount + 1);
    expect(urls[0]).toBe("cc-candybar://set-state/s1/theme-page/-1");
    // every option click APPLIES theme AND closes (page -1) in one batched url
    for (const u of urls.slice(1)) {
      expect(u).toMatch(
        /^cc-candybar:\/\/set-state\/s1\/theme\/[^/]+\/theme-page\/-1$/,
      );
    }
    expect(stripAnsi(line)).not.toContain("→");
    expect(stripAnsi(line)).not.toContain("←");
  });

  test("open at a narrow width: paginates with a forward arrow on page 0", () => {
    const { render, sessionState } = buildRuntime(MENU_SRC);
    sessionState.set("s1", "theme-page", "0");
    const line = render(34).split("\n")[1]!;
    expect(stripAnsi(line)).toContain("→");
    expect(stripAnsi(line)).not.toContain("←"); // page 0 has no back arrow
    // the forward arrow navigates to page 1 (render-computed)
    expect(extractUrls(line)).toContain(
      "cc-candybar://set-state/s1/theme-page/1",
    );
    // fewer options than the full set fit on the page
    const optionUrls = extractUrls(line).filter((u) => u.includes("/theme/"));
    expect(optionUrls.length).toBeLessThan(listResolvablePaletteNames().length);
  });

  test("navigating to a later page shows a back arrow", () => {
    const { render, sessionState } = buildRuntime(MENU_SRC);
    sessionState.set("s1", "theme-page", "1");
    const line = render(34).split("\n")[1]!;
    expect(stripAnsi(line)).toContain("←");
    expect(extractUrls(line)).toContain(
      "cc-candybar://set-state/s1/theme-page/0",
    );
  });

  test("a page beyond range clamps to the last page (back arrow, no forward)", () => {
    const { render, sessionState } = buildRuntime(MENU_SRC);
    sessionState.set("s1", "theme-page", "9999");
    const line = render(34).split("\n")[1]!;
    expect(stripAnsi(line)).toContain("←");
    expect(stripAnsi(line)).not.toContain("→");
  });

  test("the currently-selected theme is marked active (bold)", () => {
    const { render, sessionState } = buildRuntime(MENU_SRC);
    sessionState.set("s1", "theme-page", "0");
    sessionState.set("s1", "theme", "textual-dark");
    // bold SGR (1) wraps the active option's text
    const line = render(Number.POSITIVE_INFINITY).split("\n")[1]!;
    expect(line).toMatch(/\x1b\[[0-9;]*1[;m].*textual-dark/);
  });
});

// ─── Pillar 4: derived integer validator ─────────────────────────────────────

describe("k5a.6 — menu page-key validator", () => {
  test("makeIntValidator accepts integers (incl. -1) and canonicalizes", () => {
    const v = makeIntValidator("page");
    expect(v("-1")).toEqual({ ok: true, value: "-1" });
    expect(v("0")).toEqual({ ok: true, value: "0" });
    expect(v("007")).toEqual({ ok: true, value: "7" });
    expect(v("")).toEqual({ ok: false, reason: expect.any(String) });
    expect(v("1.5")).toEqual({ ok: false, reason: expect.any(String) });
    expect(v("x")).toEqual({ ok: false, reason: expect.any(String) });
  });

  test("deriveWidgetValidators derives an int validator for a menu page key", () => {
    const config = parseAndValidate("<test>", MENU_SRC, ALLOWED);
    const derived = deriveWidgetValidators(config);
    expect(derived.map((d) => d.key)).toEqual(["theme-page"]);
    expect(derived[0]!.validator("3")).toEqual({ ok: true, value: "3" });
    expect(derived[0]!.validator("nope").ok).toBe(false);
  });

  test("a menu page key colliding with a baseline key IS derived (so registration throws loudly)", () => {
    // [LAW:no-silent-fallbacks] A menu naming its page key `theme` is a
    // misconfiguration. Deriving the int validator anyway makes
    // registerStateValidator throw on the duplicate at load — loud — rather than
    // silently leaving the theme allow-list gate to reject the menu's integer
    // page writes confusingly at click time.
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      widgets: { m: { kind: 'menu', state: 'theme', items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }] } },
      segments: { s: { template: '{{ widget "m" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    const config = parseAndValidate("<test>", src, ALLOWED);
    expect(deriveWidgetValidators(config).map((d) => d.key)).toEqual(["theme"]);
  });

  test("baseline keys are not re-derived (buttons writing theme)", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      widgets: { p: { kind: 'buttons', items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }] } },
      segments: { s: { template: '{{ widget "p" }}', bg: 'surface', fg: 'foreground' } },
      layout: [['s']],
    }`;
    const config = parseAndValidate("<test>", src, ALLOWED);
    expect(deriveWidgetValidators(config)).toEqual([]);
  });
});
