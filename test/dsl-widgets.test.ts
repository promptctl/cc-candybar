// [LAW:verifiable-goals] chunk-11 .3 acceptance: a config author binds clicks to
// actions via the `widgets` seam; the rendered statusline carries one OSC-8
// region per button, and a click flows through the same verb registry the
// daemon uses, mutating SessionState so the next render reflects it.
//
// [LAW:single-enforcer] Everything drives the real spine — registerDslConfig +
// renderDsl for rendering, parseHandlerUrl + VERBS for the click — so the
// verification matches the live path, not a parallel rig.

import { PaletteResolver } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { getThemePalette } from "../src/themes/palette-registry";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { VERBS } from "../src/daemon/verbs";
import { parseHandlerUrl } from "../src/install/index";
import { extractWidgetRefs } from "../src/config/dsl-loader";
import { listResolvablePaletteNames } from "../src/themes/cascade";

const ALLOWED = new Set(["textual-dark"]);
const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  width: Number.POSITIVE_INFINITY,
};

// Extract the non-empty OSC-8 URLs (the link OPENs) from a rendered line. The
// close sequence carries an empty URL, so `[^\x1b]+` matches only opens.
function extractUrls(rendered: string): string[] {
  const re = /\x1b\]8;;([^\x1b]+)\x1b\\/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) urls.push(m[1]!);
  return urls;
}

function buildRuntime(
  src: string,
  hookData: Record<string, unknown> = { session_id: "s1" },
) {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { store });
  const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
  const render = (): string =>
    renderDsl(config, compiled, store, registry, hookData, basePalette, OPTS);
  return { config, store, registry, sessionState, render };
}

describe("DSL widgets — action buttons (chunk-11 .3)", () => {
  const ACTIONS_SRC = `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      project_dir: { kind: 'input', path: 'project_dir', default: '' },
    },
    widgets: {
      actions: {
        kind: 'buttons',
        items: [
          { glyph: '⎘', onClick: { copy: '{{ .session.id }}' } },
          { glyph: '\u{1F4C2}', onClick: { open: '{{ .project_dir }}' } },
        ],
      },
    },
    segments: {
      bar: { template: '{{ widget "actions" }}', bg: 'surface', fg: 'foreground' },
    },
    layout: [['bar']],
  }`;

  test("each button renders one OSC-8 region with its composed verb URL", () => {
    const { render } = buildRuntime(ACTIONS_SRC, {
      session_id: "s1",
      project_dir: "/proj",
    });
    const urls = extractUrls(render());
    expect(urls).toEqual([
      "cc-candybar://copy/s1",
      "cc-candybar://open-vscode/%2Fproj",
    ]);
  });

  test("rendered URLs parse back to the right verb + decoded value", () => {
    const { render } = buildRuntime(ACTIONS_SRC, {
      session_id: "s1",
      project_dir: "/proj",
    });
    const [copyUrl, openUrl] = extractUrls(render());
    expect(parseHandlerUrl(copyUrl!)).toEqual({ verb: "copy", value: "s1" });
    expect(parseHandlerUrl(openUrl!)).toEqual({
      verb: "open-vscode",
      value: "/proj",
    });
  });

  test("the widget's button text is present in the rendered line", () => {
    const { render } = buildRuntime(ACTIONS_SRC, {
      session_id: "s1",
      project_dir: "/proj",
    });
    const out = render();
    expect(out).toContain("⎘");
    expect(out).toContain("\u{1F4C2}");
  });
});

describe("DSL widgets — option picker end-to-end (chunk-11 .3)", () => {
  const PICKER_SRC = `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      theme: { kind: 'state', key: 'theme', default: '(none)' },
    },
    widgets: {
      themePicker: {
        kind: 'buttons',
        items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }],
      },
    },
    segments: {
      pick: { template: '{{ widget "themePicker" }}', bg: 'surface', fg: 'foreground' },
      cur: { template: ' cur={{ .theme }} ', bg: 'surface', fg: 'foreground' },
    },
    layout: [['pick', 'cur']],
  }`;

  const SID = "s-pick";
  const HOOK = { session_id: SID };

  test("renders one set-state region per theme, none bold before a selection", () => {
    const { render } = buildRuntime(PICKER_SRC, HOOK);
    const out = render();
    const urls = extractUrls(out);
    const themes = listResolvablePaletteNames();
    expect(urls.length).toBe(themes.length);
    // Every URL is a set-state click for the `theme` key with that option.
    for (const t of themes) {
      expect(urls).toContain(`cc-candybar://set-state/${SID}/theme/${t}`);
    }
    // No option is current yet (state default is "(none)", not a theme), so
    // no link region is marked bold. Bold is emitted as a combined SGR ending
    // ";1m" immediately before the option's OSC-8 open — check that shape, not
    // a standalone "\x1b[1m" (which the renderer never emits on its own).
    expect(out).not.toContain(";1m\x1b]8;;");
  });

  test("clicking a theme writes SessionState and the next render reflects it", () => {
    const { sessionState, render } = buildRuntime(PICKER_SRC, HOOK);
    expect(render()).toContain("cur=(none)");

    const target = listResolvablePaletteNames()[0]!;
    const url = `cc-candybar://set-state/${SID}/theme/${target}`;
    const parsed = parseHandlerUrl(url);
    expect(parsed.verb).toBe("set-state");

    // Dispatch through the same verb the daemon invokes for a wire click.
    VERBS.get("set-state")!(parsed.value, { sessionState, dlog: () => {} });

    const after = render();
    expect(after).toContain(`cur=${target}`);
    // The chosen option is now marked current: its OSC-8 region is preceded by
    // a bold SGR (";1m"), and no other option is.
    expect(after).toContain(
      `;1m\x1b]8;;cc-candybar://set-state/${SID}/theme/${target}\x1b\\`,
    );
    const boldRegions = after.match(/;1m\x1b\]8;;/g) ?? [];
    expect(boldRegions.length).toBe(1);
  });
});

describe("DSL widgets — active marking via differently-named state var", () => {
  // [LAW:one-source-of-truth] The state var is named `themeName` but reads the
  // `theme` key the picker writes. Active-marking must resolve key→var and mark
  // the current option — not assume a var literally named `theme`.
  const SRC = `{
    globals: {},
    variables: {
      'session.id': { kind: 'input', path: 'session_id', default: '' },
      themeName: { kind: 'state', key: 'theme', default: '(none)' },
    },
    widgets: {
      themePicker: { kind: 'buttons', items: [{ optionsFrom: 'themes', onClick: { set: 'theme' } }] },
    },
    segments: { pick: { template: '{{ widget "themePicker" }}', bg: 'surface', fg: 'foreground' } },
    layout: [['pick']],
  }`;

  test("marks the current option even when the state var name differs from the key", () => {
    const SID = "s-named";
    const { sessionState, render } = buildRuntime(SRC, { session_id: SID });
    expect(render()).not.toContain(";1m\x1b]8;;");
    const target = listResolvablePaletteNames()[0]!;
    VERBS.get("set-state")!(`${SID}/theme/${target}`, {
      sessionState,
      dlog: () => {},
    });
    const after = render();
    expect(after).toContain(
      `;1m\x1b]8;;cc-candybar://set-state/${SID}/theme/${target}\x1b\\`,
    );
  });
});

describe("DSL widgets — loader validation (chunk-11 .3)", () => {
  const wrap = (widgets: string, template = '{{ widget "w" }}') => `{
    globals: {},
    variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
    widgets: ${widgets},
    segments: { s: { template: '${template}', bg: 'surface', fg: 'foreground' } },
    layout: [['s']],
  }`;

  test("a valid buttons widget loads", () => {
    expect(() =>
      parseAndValidate(
        "<t>",
        wrap(`{ w: { kind: 'buttons', items: [ { glyph: 'x', onClick: { copy: 'hi' } } ] } }`),
        ALLOWED,
      ),
    ).not.toThrow();
  });

  test("a template referencing an unknown widget is rejected", () => {
    expect(() =>
      parseAndValidate(
        "<t>",
        wrap(
          `{ w: { kind: 'buttons', items: [ { glyph: 'x', onClick: { copy: 'hi' } } ] } }`,
          '{{ widget "nope" }}',
        ),
        ALLOWED,
      ),
    ).toThrow(/unknown widget "nope"/);
  });

  test("mixing set with copy in one onClick is rejected (compound is a follow-up)", () => {
    expect(() =>
      parseAndValidate(
        "<t>",
        wrap(
          `{ w: { kind: 'buttons', items: [ { glyph: 'x', onClick: [ { set: 'theme', to: 'nord' }, { copy: 'hi' } ] } ] } }`,
        ),
        ALLOWED,
      ),
    ).toThrow(/cannot mix "set" with "copy"\/"open"/);
  });

  test("an unknown optionsFrom source is rejected", () => {
    expect(() =>
      parseAndValidate(
        "<t>",
        wrap(`{ w: { kind: 'buttons', items: [ { optionsFrom: 'colours', onClick: { set: 'theme' } } ] } }`),
        ALLOWED,
      ),
    ).toThrow(/optionsFrom must be one of/);
  });

  test("an empty set key is rejected (undeliverable on the wire)", () => {
    expect(() =>
      parseAndValidate(
        "<t>",
        wrap(`{ w: { kind: 'buttons', items: [ { glyph: 'x', onClick: { set: '', to: 'v' } } ] } }`),
        ALLOWED,
      ),
    ).toThrow(/set key must be non-empty/);
  });

  test("an empty set value is rejected (undeliverable on the wire)", () => {
    expect(() =>
      parseAndValidate(
        "<t>",
        wrap(`{ w: { kind: 'buttons', items: [ { glyph: 'x', onClick: { set: 'k', to: '' } } ] } }`),
        ALLOWED,
      ),
    ).toThrow(/set value must be non-empty/);
  });

  test("a fixed button with neither glyph nor label is rejected", () => {
    expect(() =>
      parseAndValidate(
        "<t>",
        wrap(`{ w: { kind: 'buttons', items: [ { onClick: { copy: 'hi' } } ] } }`),
        ALLOWED,
      ),
    ).toThrow(/must declare a non-empty "glyph" or "label"/);
  });

  test("an empty-string glyph (no label) is rejected as no clickable text", () => {
    expect(() =>
      parseAndValidate(
        "<t>",
        wrap(`{ w: { kind: 'buttons', items: [ { glyph: '', onClick: { copy: 'hi' } } ] } }`),
        ALLOWED,
      ),
    ).toThrow(/must declare a non-empty "glyph" or "label"/);
  });

  test("an unknown key on an action object is rejected", () => {
    expect(() =>
      parseAndValidate(
        "<t>",
        wrap(`{ w: { kind: 'buttons', items: [ { glyph: 'x', onClick: { set: 'theme', to: 'nord', too: 'oops' } } ] } }`),
        ALLOWED,
      ),
    ).toThrow(/Unknown key "too" on a set action/);
  });

  test("extractWidgetRefs ignores `widget \"x\"` mentioned inside a string literal", () => {
    // [LAW:no-silent-fallbacks] A real code-position `widget "name"` is a ref;
    // the same text INSIDE a string literal is part of one string span, not a
    // call, so it must NOT be extracted (no spurious unknown-widget error).
    expect([...extractWidgetRefs(`{{ widget "real" }}`)]).toEqual(["real"]);
    expect([...extractWidgetRefs(`{{ printf 'widget "ghost"' }}`)]).toEqual([]);
    expect([
      ...extractWidgetRefs(`{{ printf "say widget \\"ghost\\"" }} {{ widget "real" }}`),
    ]).toEqual(["real"]);
  });

  test("an unknown widget ref in a non-template field (bg) is caught at load", () => {
    expect(() =>
      parseAndValidate(
        "<t>",
        `{
          globals: {},
          variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
          widgets: { w: { kind: 'buttons', items: [ { glyph: 'x', onClick: { copy: 'hi' } } ] } },
          segments: { s: { template: '{{ widget "w" }}', bg: '{{ widget "ghost" }}', fg: 'foreground' } },
          layout: [['s']],
        }`,
        ALLOWED,
      ),
    ).toThrow(/bg references unknown widget "ghost"/);
  });

  test("a fixed button cannot carry an optionsFrom-style bare set (needs `to`)", () => {
    expect(() =>
      parseAndValidate(
        "<t>",
        wrap(`{ w: { kind: 'buttons', items: [ { glyph: 'x', onClick: { set: 'k' } } ] } }`),
        ALLOWED,
      ),
    ).toThrow(/requires "to"/);
  });

  test("an optionsFrom button with a copy action is rejected (option unused)", () => {
    expect(() =>
      parseAndValidate(
        "<t>",
        wrap(`{ w: { kind: 'buttons', items: [ { optionsFrom: 'themes', onClick: { copy: 'hi' } } ] } }`),
        ALLOWED,
      ),
    ).toThrow(/optionsFrom button's onClick must be "set"/);
  });

  test("an optionsFrom button with an explicit `to` is rejected (option supplies it)", () => {
    expect(() =>
      parseAndValidate(
        "<t>",
        wrap(`{ w: { kind: 'buttons', items: [ { optionsFrom: 'themes', onClick: { set: 'theme', to: 'nord' } } ] } }`),
        ALLOWED,
      ),
    ).toThrow(/supplies the set value from each option/);
  });
});
