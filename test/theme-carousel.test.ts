// [LAW:verifiable-goals] brandon-theme-picker-bgw.ef6 — the theme carousel and
// the preview beneath it, measured against the contract rather than bytes:
//
//   1. rotation: ◀ writes the option before the centre and ▶ the one after it,
//      wrapping at both ends, and each write is the option the ring lands on —
//      a rotation APPLIES, it never moves a highlight ahead of the value;
//   2. the centre is the value the key holds, so after a click the ring is
//      centred on what the click wrote;
//   3. neighbours are shown only while the row has room for them;
//   4. in the settings menu the theme, look and style controls open a carousel
//      and no longer a grid picker; the theme and look carousels carry the
//      preview beneath them;
//   5. every colour in the preview is a colour the bar draws under that theme
//      (and under that look): the closed cells' tints, the open state and its
//      plane, the alerts.

import { getThemePalette } from "@promptctl/rich-js";
import type { RichText, Style, ThemeKey } from "@promptctl/rich-js";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { SessionState } from "../src/daemon/session-state";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { listResolvablePaletteNames } from "../src/themes/policy";
import {
  resolveThemeSelection,
  transposedPalette,
} from "../src/themes/palette-resolvers";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import { VERBS } from "../src/daemon/verbs";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { parseHandlerUrl } from "../src/install/index";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { links, stripAnsi } from "./helpers/ansi";
import {
  CAROUSEL_NEXT,
  CAROUSEL_PREV,
  neighbourLevels,
} from "../src/render/carousel";
import { previewSwatches } from "../src/render/theme-preview";
import { sharedMenuStateKey } from "../src/config/menu-keys";
import type { ValidatedConfig } from "../src/config/dsl-types";

const ALLOWED = new Set(listResolvablePaletteNames());
const SID = "ef6";

function opts(width: number) {
  return {
    style: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    wrap: true,
    padding: 0,
    charset: "unicode" as const,
    width,
  };
}

// One rig over the real cascade: parse on the bundled default (where the
// settings menu is synthesized), install the derived gates, render through
// renderDsl with the session's theme and look resolved the way the daemon
// resolves them, and click through the real verb handlers.
function rig(source: string, width = 200) {
  const config: ValidatedConfig = parseAndValidate(
    "<user>",
    source,
    ALLOWED,
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp" });
  const gates = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  const ctx = testVerbContext(sessionState);
  const sink = new Map<string, readonly RichText[]>();
  let last = "";
  const render = (): string => {
    const lookName = sessionState.get(SID, "look");
    const lookKey = lookName == null ? undefined : config.looks[lookName];
    last = renderDsl(
      config,
      compiled,
      store,
      registry,
      {
        hook_event_name: "Status",
        session_id: SID,
        cwd: "/tmp",
        model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
        workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
        term: { cols: width },
        style: { effective: sessionState.get(SID, "style") ?? "powerline" },
        preset: { effective: "default" },
        autoWrap: { effective: true },
        padding: { effective: 0 },
      },
      opts(width),
      { perSegmentSink: sink },
      {
        theme: resolveThemeSelection(
          undefined,
          sessionState.get(SID, "theme"),
          config.globals.palette,
        ),
        ...(lookKey !== undefined && {
          look: { kind: "decided" as const, name: lookName!, value: lookKey },
        }),
      },
    );
    return last;
  };
  const click = (url: string): void => {
    const { verb, value } = parseHandlerUrl(url);
    const effects =
      verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
    for (const e of effects) VERBS.get(e.verb)!(e.value, ctx);
  };
  // Click the link whose visible text is `text`, in the bar as last rendered.
  const clickText = (text: string): void => {
    const hit = links(last).find((l) => stripAnsi(l.text) === text);
    if (hit === undefined) {
      throw new Error(
        `no link "${text}" in:\n${stripAnsi(last)}\nlinks: ${links(last)
          .map((l) => JSON.stringify(stripAnsi(l.text)))
          .join(" ")}`,
      );
    }
    click(hit.url);
    render();
  };
  // Click the link whose writes include [key, value] — how a test names one
  // control among several that share a glyph (every closed toggle is ▸).
  const clickWriting = (key: string, value: string): void => {
    const hit = links(last).find((l) =>
      effectsOf(l.url).some((e) => e.args[1] === key && e.args[2] === value),
    );
    if (hit === undefined) throw new Error(`no link writes ${key}=${value}`);
    click(hit.url);
    render();
  };
  // The link whose visible text is `text` among those writing `key`.
  const linkOn = (key: string, text: string) =>
    links(last).find(
      (l) =>
        stripAnsi(l.text) === text &&
        effectsOf(l.url).some((e) => e.args[1] === key),
    )!;
  return {
    config,
    render,
    clickText,
    clickWriting,
    linkOn,
    click: (url: string) => {
      click(url);
      render();
    },
    sink,
    sessionState,
    dispose: () => {
      for (const d of gates) d();
      registry.dispose();
    },
  };
}

// The session writes a link performs — [key, value] pairs.
const writesOf = (url: string): string[][] =>
  effectsOf(url).map((e) => e.args.slice(1));

const CAROUSEL_ONLY = `{
  variables: { pick: { kind: 'state', key: 'pick', default: 'a' } },
  actions: { choose: { set: 'pick', from: ['a', 'b', 'c', 'd', 'e'] } },
  segments: { ring: { template: '{{ carousel "choose" }}' } },
  root: { rows: { identity: { h: ['ring'] }, status: { h: [] } } },
}`;

describe("the carousel rotates by applying", () => {
  const arrows = (rendered: string) => {
    const all = links(rendered);
    const at = (glyph: string) =>
      writesOf(all.find((l) => stripAnsi(l.text) === glyph)!.url);
    return { prev: at(CAROUSEL_PREV), next: at(CAROUSEL_NEXT) };
  };

  test("◀ writes the option before the centre and ▶ the one after, wrapping at both ends", () => {
    const rt = rig(CAROUSEL_ONLY);
    const expected: Record<string, [string, string]> = {
      a: ["e", "b"],
      c: ["b", "d"],
      e: ["d", "a"],
    };
    for (const [centre, [prev, next]] of Object.entries(expected)) {
      rt.sessionState.set(SID, "pick", centre);
      const { prev: p, next: n } = arrows(rt.render());
      expect([centre, p, n]).toEqual([centre, [["pick", prev]], [["pick", next]]]);
    }
    rt.dispose();
  });

  test("a rotation lands the ring on the option it wrote, both ways round", () => {
    const rt = rig(CAROUSEL_ONLY);
    rt.render();
    const centre = () => rt.sessionState.get(SID, "pick");
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      rt.clickText(CAROUSEL_NEXT);
      seen.push(centre()!);
    }
    expect(seen).toEqual(["b", "c", "d", "e", "a", "b"]);
    seen.length = 0;
    for (let i = 0; i < 3; i++) {
      rt.clickText(CAROUSEL_PREV);
      seen.push(centre()!);
    }
    expect(seen).toEqual(["a", "e", "d"]);
    rt.dispose();
  });

  test("every name in the ring applies itself, and only the centre reads as current", () => {
    const rt = rig(CAROUSEL_ONLY);
    rt.sessionState.set(SID, "pick", "c");
    const rendered = rt.render();
    const names = links(rendered).filter(
      (l) =>
        ![CAROUSEL_PREV, CAROUSEL_NEXT].includes(stripAnsi(l.text)) &&
        effectsOf(l.url).some((e) => e.args[1] === "pick"),
    );
    expect(names.map((l) => [stripAnsi(l.text), writesOf(l.url)])).toEqual([
      ["a", [["pick", "a"]]],
      ["b", [["pick", "b"]]],
      ["c", [["pick", "c"]]],
      ["d", [["pick", "d"]]],
      ["e", [["pick", "e"]]],
    ]);
    expect(stripAnsi(rendered)).toContain(`a b ${CAROUSEL_PREV} c ${CAROUSEL_NEXT} d e`);
    rt.dispose();
  });

  test("neighbours come in symmetric pairs, only while they fit, never repeating an option", () => {
    const names = ["aa", "bb", "cc", "dd", "ee", "ff", "gg"];
    const ring = (d: number) => names[((d % 7) + 7) % 7]!;
    // ◀ aa ▶ = 6 cols; each level adds two names and two spaces = 6.
    expect(neighbourLevels(ring, 7, 6, 6)).toBe(0);
    expect(neighbourLevels(ring, 7, 6, 11)).toBe(0);
    expect(neighbourLevels(ring, 7, 6, 12)).toBe(1);
    expect(neighbourLevels(ring, 7, 6, 1000)).toBe(3);
    // Two options: the one neighbour is both ◀ and ▶, so the ring shows none.
    expect(neighbourLevels(ring, 2, 6, 1000)).toBe(0);
  });
});

// The door, then ⚙ config, then one control's carousel.
const PICKERS = sharedMenuStateKey("settings.pickers");
function openCarousel(rt: ReturnType<typeof rig>, control: string): void {
  rt.render();
  rt.clickText("🍫");
  rt.clickText("⚙ config ▸");
  rt.clickWriting(PICKERS, `settings.apply.${control}`);
}

describe("the settings menu's theme, look and style controls are carousels", () => {
  test("opening the theme control drops a carousel and the preview, not a grid", () => {
    const rt = rig(`{ globals: { palette: 'nord' } }`);
    openCarousel(rt, "theme");
    const text = stripAnsi(rt.render());
    expect(text).toMatch(new RegExp(`${CAROUSEL_PREV} nord ${CAROUSEL_NEXT}`));
    expect(rt.sink.has("settings.carousel.theme.0")).toBe(true);
    // No grid: the picker's page arrows are gone, and no option cell writes a
    // page cursor.
    expect(text).not.toMatch(/[←→]/);
    rt.dispose();
  });

  test("▶ applies the next theme and the whole bar recolours; ◀ takes it back", () => {
    const rt = rig(`{ globals: { palette: 'nord' } }`);
    openCarousel(rt, "theme");
    const themes = listResolvablePaletteNames();
    const next = themes[(themes.indexOf("nord") + 1) % themes.length]!;
    const before = rt.sink.get("directory")![0]!.style;
    rt.click(rt.linkOn("theme", CAROUSEL_NEXT).url);
    expect(rt.sessionState.get(SID, "theme")).toBe(next);
    expect(stripAnsi(rt.render())).toContain(`${CAROUSEL_PREV} ${next} ${CAROUSEL_NEXT}`);
    expect(rt.sink.get("directory")![0]!.style).not.toEqual(before);
    rt.click(rt.linkOn("theme", CAROUSEL_PREV).url);
    expect(rt.sessionState.get(SID, "theme")).toBe("nord");
    rt.dispose();
  });
});

// A style's background, as hex, or undefined when it paints none.
const bgHex = (style: string | Style | undefined): string | undefined =>
  typeof style === "object" ? style.bgcolor?.value?.hex : undefined;

// The colours a rendered fragment list draws backgrounds in.
const backgrounds = (cells: readonly RichText[]): Set<string> =>
  new Set(
    cells
      .flatMap((cell) => [cell.style, ...cell.spans.map((span) => span.style)])
      .map(bgHex)
      .filter((hex): hex is string => hex !== undefined),
  );

describe("the preview is the bar's own colours", () => {
  const IDENTITY: ThemeKey = {
    hueShift: 0,
    chromaScale: 1,
    lightnessScale: 1,
    lightnessShift: 0,
  };

  test.each(["nord", "gruvbox", "rose-pine-dawn", "textual-light"])(
    "%s: the preview draws exactly the colours the bar under it draws",
    (theme) => {
      const rt = rig(`{ globals: { palette: '${theme}' } }`);
      openCarousel(rt, "theme");
      const palette = transposedPalette(getThemePalette(theme)!, IDENTITY);
      const swatches = new Set(
        previewSwatches(palette).flat().map((s) => s.colour.hex),
      );
      // What the preview segment actually drew is the swatch set.
      const drawn = backgrounds(rt.sink.get("settings.carousel.theme.0")!);
      expect([...swatches].filter((hex) => !drawn.has(hex))).toEqual([]);
      // The open door wears the open state the preview shows beside its plane.
      const door = bgHex(rt.sink.get("settings.menu")![0]!.style);
      expect(swatches.has(door!)).toBe(true);
      // Every closed bar cell that authors no meaning wears a preview tint.
      for (const name of ["directory", "model", "gitaculous"]) {
        const cells = rt.sink.get(name);
        if (cells === undefined) continue;
        expect([name, swatches.has(bgHex(cells[0]!.style)!)]).toEqual([name, true]);
      }
      rt.dispose();
    },
  );

  test("under a look the preview is the looked palette the bar wears — the look carousel previews it", () => {
    const rt = rig(`{ globals: { palette: 'gruvbox' } }`);
    openCarousel(rt, "look");
    rt.click(rt.linkOn("look", CAROUSEL_NEXT).url);
    const look = rt.sessionState.get(SID, "look")!;
    expect(look).not.toBe("none");
    const palette = transposedPalette(
      getThemePalette("gruvbox")!,
      rt.config.looks[look]!,
    );
    const swatches = new Set(
      previewSwatches(palette).flat().map((s) => s.colour.hex),
    );
    const drawn = backgrounds(rt.sink.get("settings.carousel.look.0")!);
    expect([...swatches].filter((hex) => !drawn.has(hex))).toEqual([]);
    expect(swatches.has(bgHex(rt.sink.get("directory")![0]!.style)!)).toBe(true);
    rt.dispose();
  });

  test("the style carousel has no preview row: a strip shape is not a palette", () => {
    const rt = rig(`{}`);
    openCarousel(rt, "style");
    expect(rt.sink.has("settings.carousel.style")).toBe(true);
    expect(rt.sink.has("settings.carousel.style.0")).toBe(false);
    rt.dispose();
  });
});
