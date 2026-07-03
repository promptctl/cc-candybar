// [LAW:verifiable-goals] 2de.13 acceptance for the picker helper, driven through
// the real spine (registerDslConfig + renderDsl), the real loader
// (parseAndValidate), and the real set-state gate (deriveActionValidators +
// registerStateValidator + validateStateWrite) — never a parallel rig:
//
//   1. `{{ picker "apply" "page" closeOnPick paged }}` renders a width-fit run of
//      option cells over named actions, with ✕/←/→ navigating the page cursor.
//   2. paged=true slices to term.cols with ←/→; paged=false emits one page (wrap).
//   3. closeOnPick=true makes an option click apply AND reset the page key in ONE
//      atomic set-state; closeOnPick=false (and the OMITTED default) applies only
//      — the menu stays open so themes can be tried in a row.
//   4. The page key gates as an unbounded int DERIVED from the `int` action arm;
//      the apply key gates as the resolved option allow-list.
//   5. The active option (current value) renders bold.
//   6. The loader rejects a picker referencing an undeclared action.

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { paginate } from "../src/render/picker";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  deriveActionValidators,
  registerStateValidator,
  validateStateWrite,
} from "../src/daemon/verbs/state-validators";
import { ConfigError } from "../src/config/dsl-loader";
import { effectsOf, boldUrls } from "./helpers/click";

const ALLOWED = new Set(listResolvablePaletteNames());
const THEMES = listResolvablePaletteNames();

function opts(width: number) {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const, wrap: true, padding: 0,
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

// The standard theme picker: a trigger that opens the menu (literal 0 on the
// int-gated page key), and a width-gated menu segment. closeOnPick/paged vary.
function pickerConfig(closeOnPick: boolean, paged: boolean): string {
  return `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      theme: { kind: 'state', key: 'theme-pick', default: '${THEMES[0]}' },
      page: { kind: 'state', key: 'theme-page', default: '-1' },
      'term.cols': { kind: 'input', path: 'term.cols', type: 'number', default: 80 },
    },
    actions: {
      openMenu: { set: 'theme-page', to: '0' },
      applyTheme: { set: 'theme-pick', from: 'themes' },
      themePage: { set: 'theme-page', int: true },
    },
    segments: {
      trigger: { template: '{{ action "openMenu" "▸" }}', bg: 'surface', fg: 'foreground' },
      menu: {
        template: '{{ picker "applyTheme" "themePage" ${closeOnPick} ${paged} }}',
        when: '{{ ge (int .page) 0 }}',
        bg: 'surface', fg: 'foreground',
      },
    },
    root: { v: ['trigger', 'menu'] },
  }`;
}

function buildRuntime(src: string, sessionId = "s1") {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
  const render = (width: number): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      { session_id: sessionId, project_dir: "/tmp/proj" },
      basePalette,
      opts(width),
    );
  const disposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  const click = (url: string): void => {
    for (const { verb, args } of effectsOf(url)) {
      if (verb !== "set-state") continue;
      const [sid, ...pairs] = args;
      for (let i = 0; i < pairs.length; i += 2) {
        const result = validateStateWrite(pairs[i]!, pairs[i + 1]!);
        if (!result.ok) throw new Error(`click rejected: ${result.reason}`);
        sessionState.set(sid!, pairs[i]!, result.value);
      }
    }
  };
  const dispose = (): void => disposers.forEach((d) => d());
  return { config, store, sessionState, render, click, dispose };
}

describe("2de.13 — picker: open / apply-and-close / page nav", () => {
  test("a closed menu (page -1) is absent; opening shows ✕ + a page + active mark", () => {
    const { render, click, sessionState, dispose } = buildRuntime(
      pickerConfig(true, true),
    );
    // Closed: the when-gate (page>=0) drops the row entirely — only the trigger.
    const closed = stripAnsi(render(80));
    expect(closed).toContain("▸");
    expect(closed).not.toContain("✕");

    // Open via the trigger (writes theme-page=0 through the int gate).
    const triggerUrl = extractUrls(render(80)).find((u) =>
      effectsOf(u).some((e) =>
        e.args.includes("theme-page") && e.args.includes("0"),
      ),
    );
    expect(triggerUrl).toBeDefined();
    click(triggerUrl!);
    expect(sessionState.get("s1", "theme-page")).toBe("0");

    const open = render(80);
    expect(stripAnsi(open)).toContain("✕");
    // The default theme (current) renders bold (active).
    expect(boldUrls(open).join(" ")).toContain(THEMES[0]!);
    dispose();
  });

  test("clicking a theme applies AND closes (closeOnPick=true): one atomic set-state", () => {
    const { render, click, sessionState, dispose } = buildRuntime(
      pickerConfig(true, true),
    );
    sessionState.set("s1", "theme-page", "0");
    const open = render(80);
    const themeUrl = extractUrls(open).find((u) => {
      const e = effectsOf(u)[0]!;
      return (
        e.verb === "set-state" &&
        e.args.includes("theme-pick") &&
        e.args.includes("theme-page")
      );
    });
    expect(themeUrl).toBeDefined();
    // ONE set-state effect writing BOTH keys (apply + close), atomically.
    const eff = effectsOf(themeUrl!);
    expect(eff).toHaveLength(1);
    expect(eff[0]!.verb).toBe("set-state");
    expect(eff[0]!.args.slice(-2)).toEqual(["theme-page", "-1"]);
    click(themeUrl!);
    expect(sessionState.get("s1", "theme-page")).toBe("-1"); // closed
    dispose();
  });

  test("closeOnPick=false: a theme click applies only (no page reset)", () => {
    const { render, sessionState, dispose } = buildRuntime(
      pickerConfig(false, true),
    );
    sessionState.set("s1", "theme-page", "0");
    const themeUrl = extractUrls(render(80)).find((u) => {
      const e = effectsOf(u)[0]!;
      return e.verb === "set-state" && e.args.includes("theme-pick");
    });
    expect(themeUrl).toBeDefined();
    // Apply only: the page key is NOT in the write.
    expect(effectsOf(themeUrl!)[0]!.args).not.toContain("theme-page");
    dispose();
  });

  test("default (closeOnPick omitted) is stay-open: a theme click applies only, menu still renders", () => {
    // The trailing bools are optional; omitting closeOnPick must default to
    // false (stay-open), NOT silently close. The picker still renders open.
    const src = pickerConfig(true, true).replace(
      '{{ picker "applyTheme" "themePage" true true }}',
      '{{ picker "applyTheme" "themePage" }}',
    );
    const { render, sessionState, dispose } = buildRuntime(src);
    sessionState.set("s1", "theme-page", "0");
    const open = render(80);
    expect(stripAnsi(open)).toContain("✕"); // open: the close affordance is present
    const themeUrl = extractUrls(open).find((u) => {
      const e = effectsOf(u)[0]!;
      return e.verb === "set-state" && e.args.includes("theme-pick");
    });
    expect(themeUrl).toBeDefined();
    // Default closeOnPick=false ⇒ the page key is NOT written (menu stays open).
    expect(effectsOf(themeUrl!)[0]!.args).not.toContain("theme-page");
    dispose();
  });

  test("paged: a narrow width slices into pages with → ; clicking → advances the cursor", () => {
    const { render, click, sessionState, dispose } = buildRuntime(
      pickerConfig(true, true),
    );
    sessionState.set("s1", "theme-page", "0");
    const open = render(30); // narrow → forces multiple pages
    const plain = stripAnsi(open);
    expect(plain).toContain("→");
    // Not every theme fits on the first narrow page.
    const shown = THEMES.filter((t) => plain.includes(t));
    expect(shown.length).toBeLessThan(THEMES.length);
    // The → click advances the page cursor by one.
    const nextUrl = extractUrls(open).find((u) =>
      effectsOf(u).some(
        (e) => e.args.includes("theme-page") && e.args.includes("1"),
      ),
    );
    expect(nextUrl).toBeDefined();
    click(nextUrl!);
    expect(sessionState.get("s1", "theme-page")).toBe("1");
    dispose();
  });

  test("wrap (paged=false): one page of ALL themes, no ←/→ even when narrow", () => {
    const { render, sessionState, dispose } = buildRuntime(
      pickerConfig(true, false),
    );
    sessionState.set("s1", "theme-page", "0");
    const plain = stripAnsi(render(30));
    expect(plain).toContain("✕");
    expect(plain).not.toContain("→");
    expect(plain).not.toContain("←");
    // Every theme is present (the long line wraps via FlexStrip, none dropped).
    for (const t of THEMES) expect(plain).toContain(t);
    dispose();
  });
});

describe("2de.13 — picker gate derivation (int arm)", () => {
  test("derives an apply allow-list + a page int spec from the action table", () => {
    const config = parseAndValidate("<test>", pickerConfig(true, true), ALLOWED);
    const derived = deriveActionValidators(config);
    const byKey = new Map(derived.map((d) => [d.key, d.spec]));
    expect(byKey.get("theme-pick")).toEqual({
      kind: "allow-list",
      allowed: THEMES,
    });
    // openMenu's literal "0" (allow-list) MERGES into themePage's int spec —
    // an integer member is absorbed; the gate is int.
    expect(byKey.get("theme-page")).toEqual({ kind: "int" });
  });

  test("the int gate accepts any integer (-1 closed, page indices) and rejects non-int", () => {
    const config = parseAndValidate("<test>", pickerConfig(true, true), ALLOWED);
    const disposers = deriveActionValidators(config).map(({ key, spec }) =>
      registerStateValidator(key, spec),
    );
    expect(validateStateWrite("theme-page", "-1").ok).toBe(true);
    expect(validateStateWrite("theme-page", "0").ok).toBe(true);
    expect(validateStateWrite("theme-page", "7").ok).toBe(true);
    expect(validateStateWrite("theme-page", "x").ok).toBe(false);
    disposers.forEach((d) => d());
  });
});

describe("2de.13 — picker loader validation", () => {
  test("rejects a picker referencing an undeclared action", () => {
    const src = `{
      globals: {},
      variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
      actions: { applyTheme: { set: 'theme-pick', from: 'themes' } },
      segments: { menu: { template: '{{ picker "applyTheme" "nope" true true }}', bg: 'surface', fg: 'foreground' } },
      root: 'menu',
    }`;
    expect(() => parseAndValidate("<test>", src, ALLOWED)).toThrow(ConfigError);
    expect(() => parseAndValidate("<test>", src, ALLOWED)).toThrow(/nope/);
  });

  test("paginate: infinite width yields one page; finite width fills greedily", () => {
    expect(paginate([3, 3, 3], Infinity, 2)).toEqual([[0, 1, 2]]);
    // usable = 10 - 2 = 8: 3 + 1 + 3 = 7 fits; + 1 + 3 = 11 overflows → new page.
    expect(paginate([3, 3, 3], 10, 2)).toEqual([[0, 1], [2]]);
  });
});
