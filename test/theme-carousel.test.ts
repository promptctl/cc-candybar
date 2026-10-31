// [LAW:verifiable-goals] brandon-theme-picker-bgw.ef6 — the theme carousel and
// the preview beneath it, measured against the contract rather than bytes:
//
//   1. rotation: ◀ writes the option before the centre and ▶ the one after it,
//      wrapping at both ends, and each write is the option the ring lands on —
//      a rotation APPLIES, it never moves a highlight ahead of the value;
//   2. the ring is centred on the value the key holds, so after a click the
//      arrows step from what the click wrote;
//   3. in the settings menu every option control is `◀ label ▶` — the bare
//      carousel — whose label names the setting and opens a plain list of
//      every option (brandon-menu-ia-q30.jl1); the theme and style lists
//      carry the preview beneath them;
//   4. every colour in the preview is a colour the bar draws under that theme
//      (and under that style): the closed cells' tints, the open state and its
//      plane, the alerts.

import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { resolvedStyle } from "../src/render/rich-theme.js";
import { ColorDepth, getThemePalette, transposePalette } from "@promptctl/rich-js";
import { RichText as RichTextValue } from "@promptctl/rich-js";
import type { Palette, RichText, TextStyle, ThemeKey } from "@promptctl/rich-js";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { PRESET_DELETE_GLYPH } from "../src/config/settings-menu";
import { SessionState } from "../src/daemon/session-state";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { drawnDepth, listResolvablePaletteNames } from "../src/themes/policy";
import type {
  ColorCompatibility,
  Endcaps,
} from "../src/themes/policy";
import { VERBS } from "../src/daemon/verbs";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { parseHandlerUrl } from "../src/install/index";
import { testVerbContext, effectsOf, recordRender } from "./helpers/click";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { links, stripAnsi } from "./helpers/ansi";
import { CAROUSEL_NEXT, CAROUSEL_PREV } from "../src/render/carousel";
import { decorEntryColour, windowAt } from "../src/themes/decor";
import { DEFAULT_DECOR } from "./helpers/decor";
import { renderStripCells } from "../src/render/strip";
import {
  blockLabel,
  labelBudget,
  renderLayoutPreview,
} from "../src/render/layout-preview";
import { layoutRows, type CompiledNode } from "../src/dsl/node-registry";
import { menuPageKey, sharedMenuStateKey } from "../src/config/menu-keys";
import { PLACE, TABS, within } from "../src/config/menu-places";
import type { SettingName } from "../src/config/setting-projections";
import { randomOther, SWATCHES_RANDOM } from "../src/render/swatches";
import { EDIT_MODE_KEY, EDIT_MODE_ARRANGE } from "../src/config/loader/edit-mode";
import { EDIT_NS } from "../src/config/loader/reserved-namespace";
import { EDIT_LIVE_KEY } from "../src/config/edit-chrome";
import { presetNames } from "../src/config/presets";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { instantOf } from "../src/utils/instant";

const ALLOWED = new Set(listResolvablePaletteNames());
const SID = "ef6";

function opts(
  width: number,
  padding: number,
  endcaps: Endcaps,
  colorCompatibility: ColorCompatibility = "truecolor",
) {
  return { endcaps, colorCompatibility, wrap: true, padding, width };
}

// One rig over the real cascade: parse on the bundled default (where the
// settings menu is synthesized), render through renderDsl with the session's
// theme and style resolved the way the daemon resolves them, and click through
// the real verb handlers, gated by that config.
function rig(
  source: string,
  width = 200,
  padding = 0,
  style: Endcaps = "powerline",
) {
  const config: ValidatedConfig = parseAndValidate(
    "<user>",
    source,
    ALLOWED,
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", sessionState);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
  recordRender(sessionState, SID);
  const ctx = testVerbContext(sessionState, undefined, config);
  const sink = new Map<string, readonly RichText[]>();
  let last = "";
  // The terminal's width is a fact of the render, not of the compile: one
  // compiled config draws at every width a sweep asks for.
  const render = (cols = width): string => {
    const effective = resolveEffectiveGlobals(
      config,
      (key) => sessionState.get(SID, key),
      () => false,
    );
    const depth = effective.colorCompatibility;
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
        term: { cols },
        endcaps: { effective: sessionState.get(SID, "endcaps") ?? style },
        preset: { effective: effective.preset },
        autoWrap: { effective: true },
        padding: { effective: padding },
        colorCompatibility: { effective: depth },
        variation: { effective: effective.variation },
        shade: { effective: effective.shade },
      },
      instantOf(new Date()),
      opts(cols, padding, style, depth),
      { perSegmentSink: sink },
      effective,
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
    dispose: () => registry.dispose(),
  };
}

// The session writes a link performs — [key, value] pairs.
const writesOf = (url: string): string[][] =>
  effectsOf(url).map((e) => e.args.slice(1));

const CAROUSEL_ONLY = `{
  variables: { pick: { kind: 'state', key: 'pick', default: 'a' } },
  actions: {
    choose: { set: 'pick', from: ['a', 'b', 'c', 'd', 'e'] },
    list: { set: 'listing', to: 'yes' },
  },
  segments: { ring: { template: '{{ carousel "choose" "list" "the pick" }}' } },
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

  test("the label says what is set whatever the value, and only the arrows write", () => {
    const rt = rig(CAROUSEL_ONLY);
    for (const held of ["a", "c", "x"]) {
      rt.sessionState.set(SID, "pick", held);
      const rendered = rt.render();
      expect([held, stripAnsi(rendered)]).toEqual([
        held,
        expect.stringContaining(`${CAROUSEL_PREV} the pick ${CAROUSEL_NEXT}`),
      ]);
      expect(links(rendered).filter((l) => writesOf(l.url).some(([k]) => k === "pick")).map((l) => stripAnsi(l.text)))
        .toEqual([CAROUSEL_PREV, CAROUSEL_NEXT]);
    }
    rt.dispose();
  });

  test("a click on the label fires the open action and steps nothing", () => {
    const rt = rig(CAROUSEL_ONLY);
    rt.sessionState.set(SID, "pick", "c");
    rt.render();
    rt.clickText("the pick");
    expect(rt.sessionState.get(SID, "listing")).toBe("yes");
    expect(rt.sessionState.get(SID, "pick")).toBe("c");
    rt.dispose();
  });

  test("a colour-valued domain keeps the swatch of the value in force beside the label", () => {
    const rt = rig(`{
      variables: { th: { kind: 'state', key: 'th', default: 'nord' } },
      actions: { choose: { set: 'th', from: 'themes' }, list: { set: 'listing', to: 'yes' } },
      segments: { ring: { template: '{{ carousel "choose" "list" "look" }}' } },
      root: { rows: { identity: { h: ['ring'] }, status: { h: [] } } },
    }`);
    const swatch = () => {
      rt.render();
      return rt.sink.get("ring")!.flatMap((cell) =>
        cell.spans
          .filter((span) => cell.plain.slice(span.start, span.end).includes("▀"))
          .map((span) => resolvedStyle(span.style)),
      );
    };
    expect(stripAnsi(rt.render())).toContain(`${CAROUSEL_PREV} look ▀▀▀ ${CAROUSEL_NEXT}`);
    const nord = swatch();
    rt.sessionState.set(SID, "th", "dracula");
    expect(swatch()).not.toEqual(nord);
    rt.dispose();
  });

  test("a value outside the domain counts as the first option", () => {
    const rt = rig(CAROUSEL_ONLY);
    rt.sessionState.set(SID, "pick", "x");
    rt.render();
    rt.clickText(CAROUSEL_NEXT);
    expect(rt.sessionState.get(SID, "pick")).toBe("b");
    rt.dispose();
  });

  test("a key no variable reads back is a loud error naming the variable to declare", () => {
    const rt = rig(`{
      actions: { choose: { set: 'unread', from: ['a', 'b'] }, list: { copy: 'x' } },
      segments: { ring: { template: '{{ carousel "choose" "list" "l" }}' } },
      root: { rows: { identity: { h: ['ring'] }, status: { h: [] } } },
    }`);
    expect(stripAnsi(rt.render())).toContain(
      `declare { kind: "state", key: "unread" }`,
    );
    rt.dispose();
  });

  test("a carousel naming an undeclared action is a load error, not a render surprise", () => {
    expect(() =>
      parseAndValidate(
        "<user>",
        `{ segments: { ring: { template: '{{ carousel "noSuchApply" "noSuchApply" "l" }}' } },
           root: { rows: { identity: { h: ['ring'] }, status: { h: [] } } } }`,
        ALLOWED,
        DEFAULT_DSL_CONFIG,
      ),
    ).toThrow(/unknown action "noSuchApply" \(in a picker, menu, carousel, swatch, swatches or themePreview\)/);
  });

  test("a themePreview naming an undeclared action is a load error too", () => {
    expect(() =>
      parseAndValidate(
        "<user>",
        `{ segments: { demo: { template: '{{ themePreview "noSuchApply" }}' } },
           root: { rows: { identity: { h: ['demo'] }, status: { h: [] } } } }`,
        ALLOWED,
        DEFAULT_DSL_CONFIG,
      ),
    ).toThrow(/unknown action "noSuchApply" \(in a picker, menu, carousel, swatch, swatches or themePreview\)/);
  });

  test("a carousel over the wrong kind of action names the carousel, not the picker", () => {
    const rt = rig(`{
      variables: { pick: { kind: 'state', key: 'pick', default: 'a' } },
      actions: { choose: { set: 'pick', cycle: ['a', 'b'] }, list: { copy: 'x' } },
      segments: { ring: { template: '{{ carousel "choose" "list" "l" }}' } },
      root: { rows: { identity: { h: ['ring'] }, status: { h: [] } } },
    }`);
    expect(stripAnsi(rt.render())).toContain(
      `carousel references action "choose"`,
    );
    rt.dispose();
  });

});

// The preset control's line, under which its list opens.
const PRESET_CONTROL = `${CAROUSEL_PREV} ▦ preset ${CAROUSEL_NEXT}`;

// The door, then the tab the control is in (none on the door's first line),
// then — for a setting behind the theme picker's gear — the gear, then its
// list: the click on the label between its arrows (on the theme picker, its
// label). Where a control is comes from the menu's map, as the menu lays it.
const PICKERS = sharedMenuStateKey("candybar.pickers");
const GEAR_PICKERS = sharedMenuStateKey("candybar.gearPickers");
function openPicker(rt: ReturnType<typeof rig>, control: SettingName): void {
  const place = PLACE[control];
  const behindGear = place === "gear";
  rt.render();
  rt.clickText("🍫");
  const tab = TABS.find((t) => within(place, t.member));
  if (tab !== undefined) rt.clickText(tab.label);
  if (behindGear) rt.clickWriting(PICKERS, "gear");
  rt.clickWriting(
    behindGear ? GEAR_PICKERS : PICKERS,
    `candybar.apply.${control}`,
  );
}

// The rendered rows of the body a picker opens, in order.
function bodyRows(rt: ReturnType<typeof rig>, control: string): RichText[][] {
  const rows: RichText[][] = [];
  for (let i = 0; rt.sink.has(`candybar.list.${control}.${i}`); i++) {
    rows.push([...rt.sink.get(`candybar.list.${control}.${i}`)!]);
  }
  return rows;
}

// brandon-menu-ia-q30.jl1: "a regular menu, no carousel". A control is
// `◀ label ▶`; the label opens a plain list of every option below it.
// The theme's control is the theme picker (brandon-theme-swatch-8v9r):
// `🎨 theme ▀▀▀ ⚙`, whose label opens a row of swatches over a two-row demo.
describe("the settings menu's look controls are pickers whose label opens a list", () => {
  const THEMES = listResolvablePaletteNames();
  // The links of the swatch row: every link writing the theme whose text is
  // a swatch, with the theme it writes.
  const swatchLinks = (rendered: string) =>
    links(rendered)
      .filter((l) => /▀▀▀/u.test(stripAnsi(l.text)))
      .map((l) => ({
        text: stripAnsi(l.text),
        writes: effectsOf(l.url).find((e) => e.args[1] === "theme")?.args[2],
      }))
      .filter((c) => c.writes !== undefined);

  test("closed, the theme picker is its label and the swatch of the theme in force, beside the gear", () => {
    const rt = rig(`{ globals: { palette: 'nord' } }`);
    rt.render();
    rt.clickText("🍫");
    rt.clickText("🎨 look");
    const rendered = rt.render();
    expect(stripAnsi(rendered)).toContain("🎨 theme ▀▀▀");
    // The label and the swatch are one button (`[Theme [=]]`): both open it.
    const opens = links(rendered).filter((l) =>
      ["🎨 theme", "▀▀▀"].includes(stripAnsi(l.text)),
    );
    expect(opens.map((l) => stripAnsi(l.text))).toEqual(["🎨 theme", "▀▀▀"]);
    expect(writesOf(opens[1]!.url)).toEqual(writesOf(opens[0]!.url));
    // The swatch's own link, as the bar last drew it: open, it closes again.
    const swatchButton = (drawn: string) =>
      links(drawn).find(
        (l) => stripAnsi(l.text) === "▀▀▀" && effectsOf(l.url).some((e) => e.args[1] === PICKERS),
      )!;
    rt.click(swatchButton(rendered).url);
    expect(rt.sink.has("candybar.list.theme.0")).toBe(true);
    rt.click(swatchButton(rt.render()).url);
    expect(rt.sink.has("candybar.list.theme.0")).toBe(false);
    const reopened = rt.render();
    // No ring: the theme is chosen by looking at it, not stepped by name.
    expect(stripAnsi(reopened)).not.toMatch(new RegExp(`${CAROUSEL_PREV} nord ${CAROUSEL_NEXT}`));
    // The gear opens the theme's configuration on the same accordion.
    const gear = links(rendered).find((l) => stripAnsi(l.text) === "⚙")!;
    expect(writesOf(gear.url)).toEqual([[PICKERS, "gear"]]);
    // The style, variation and shade controls are behind it, not in the tab.
    expect(rt.sink.has("candybar.style")).toBe(false);
    rt.clickWriting(PICKERS, "gear");
    for (const control of ["style", "variation", "shade"]) {
      expect([control, rt.sink.has(`candybar.${control}`)]).toEqual([control, true]);
    }
    rt.dispose();
  });

  test("open, it names the theme in force beside its swatch, over the swatch row and a two-row demo", () => {
    const rt = rig(`{ globals: { palette: 'nord' } }`);
    openPicker(rt, "theme");
    const rendered = rt.render();
    const text = stripAnsi(rendered);
    expect(text).toContain("nord ▀▀▀");
    expect(text).toContain(`${CAROUSEL_PREV} ${SWATCHES_RANDOM} ${CAROUSEL_NEXT}`);
    // The row opens on the page holding the theme in force, a run of the
    // domain in order, the one in force marked and every other not.
    const row = swatchLinks(rendered);
    expect(row.length).toBeGreaterThan(1);
    const first = THEMES.indexOf(row[0]!.writes!);
    expect(row.map((c) => c.writes)).toEqual(THEMES.slice(first, first + row.length));
    expect(row.map((c) => [c.writes, c.text])).toEqual(
      row.map((c) => [c.writes, c.writes === "nord" ? "[▀▀▀]" : " ▀▀▀ "]),
    );
    // "The name loses its styling and the swatch carries the colour": no
    // theme NAME is a link that picks a theme.
    expect(
      links(rendered).filter(
        (l) =>
          THEMES.includes(stripAnsi(l.text)) &&
          effectsOf(l.url).some((e) => e.args[1] === "theme"),
      ),
    ).toEqual([]);
    // The demo is two rows: what the closed bar wears, then what opens.
    const lines = text.split("\n");
    const bar = lines.findIndex((l) => l.includes("~/code"));
    expect(lines[bar + 1]).toContain("▾ open");
    rt.dispose();
  });

  // The rows of the open body: the first led by the body's one ✕ as a cell of
  // its own (no row draws a ✕ of its own), the rest by a blank of its width;
  // all of them fit the row that lead leaves them, at any padding and any
  // strip shape, so the terminal never breaks a row away from its lead — and
  // nothing else on the bar overflows.
  test.each(
    (["theme", "preset"] as const).flatMap((control) =>
      (["powerline", "capsule", "plain"] as const).flatMap((style) =>
        [0, 1, 2].map((padding) => [control, style, padding] as const),
      ),
    ),
  )("every row of the open %s list fits its terminal (%s, padding %i)", (control, style, padding) => {
    // One compile per case, opened once; the sweep is renders, which cost
    // nothing beside the compile they would otherwise each repeat.
    const rt = rig(`{ globals: { palette: 'nord' } }`, 200, padding, style);
    openPicker(rt, control);
    for (let width = 40; width <= 160; width += 3) {
      const lines = stripAnsi(rt.render(width)).split("\n");
      // The body drops below the row the control sits in, which may itself
      // wrap: it starts at the first line after the control holding the
      // body's first row.
      const rows = bodyRows(rt, control);
      const own = rt.sink.get(`candybar.${control}`)!.map((c) => c.plain).join("").trim();
      const head = rows[0]!.map((c) => c.plain).join("").trim().slice(0, 5);
      const at = lines.findIndex((l) => l.includes(own.slice(0, 8)));
      const start = lines.findIndex((l, i) => i > at && l.includes(head));
      const body = lines.slice(start, start + rows.flat().length);
      const ledByClose = body.map((l) => /^\W*✕/u.test(l));
      expect([width, ledByClose]).toEqual([
        width,
        body.map((_, i) => i === 0),
      ]);
      expect(body.map((l) => (l.match(/✕/gu) ?? []).length)).toEqual(
        body.map((_, i) => (i === 0 ? 1 : 0)),
      );
      const over = lines.filter((l) => new RichTextValue(l).cellLength > width);
      expect([width, over]).toEqual([width, []]);
    }
    rt.dispose();
  });

  test("▶ applies the next theme and the whole bar recolours, turning the row to it; ◀ takes it back", () => {
    const rt = rig(`{ globals: { palette: 'nord' } }`);
    openPicker(rt, "theme");
    const next = THEMES[(THEMES.indexOf("nord") + 1) % THEMES.length]!;
    const before = rt.sink.get("directory")![0]!.style;
    const step = rt.linkOn("theme", CAROUSEL_NEXT);
    const [apply, turn] = writesOf(step.url);
    expect(apply).toEqual(["theme", next]);
    // The page it lands on, as itself: a page number, never a sentinel.
    expect(turn![0]).toBe(menuPageKey(PICKERS));
    expect(turn![1]).toMatch(/^\d+$/);
    rt.click(step.url);
    expect(rt.sessionState.get(SID, "theme")).toBe(next);
    expect(stripAnsi(rt.render())).toContain(`${next} ▀▀▀`);
    expect(swatchLinks(rt.render()).find((c) => c.writes === next)?.text).toBe("[▀▀▀]");
    expect(rt.sink.get("directory")![0]!.style).not.toEqual(before);
    rt.click(rt.linkOn("theme", CAROUSEL_PREV).url);
    expect(rt.sessionState.get(SID, "theme")).toBe("nord");
    rt.dispose();
  });

  test("◀ from the first theme wraps to the last, and the row turns to the page holding it", () => {
    const first = THEMES[0]!;
    const last = THEMES[THEMES.length - 1]!;
    // Narrow enough that the swatches page, so the last is on another page.
    const rt = rig(`{ globals: { palette: '${first}' } }`, 80);
    openPicker(rt, "theme");
    expect(swatchLinks(rt.render()).some((c) => c.writes === last)).toBe(false);
    rt.click(rt.linkOn("theme", CAROUSEL_PREV).url);
    expect(rt.sessionState.get(SID, "theme")).toBe(last);
    expect(swatchLinks(rt.render()).find((c) => c.writes === last)?.text).toBe("[▀▀▀]");
    rt.dispose();
  });

  test("a step keeps open a row whose own when reads its cursor below zero as closed", () => {
    // The standalone-picker idiom: the row shows at page ≥ 0. A step writes
    // the page it lands on, so ◀ ? ▶ never close the row they sit in.
    const rt = rig(`{
      variables: { themesPage: { kind: 'state', key: 'themes-page', default: '0' } },
      actions: {
        applyTheme: { set: 'theme', from: 'themes' },
        themesPage: { set: 'themes-page', int: true },
      },
      segments: { row: { template: '{{ swatches "applyTheme" "themesPage" }}' } },
      root: { rows: {
        identity: { h: [{ seg: 'row', when: '{{ ge (int .themesPage) 0 }}' }] },
        status: { h: [] },
      } },
    }`);
    rt.render();
    for (const glyph of [CAROUSEL_NEXT, SWATCHES_RANDOM, CAROUSEL_PREV]) {
      rt.click(rt.linkOn("theme", glyph).url);
      expect([glyph, rt.sink.has("row")]).toEqual([glyph, true]);
    }
    rt.dispose();
  });

  test("? applies a theme other than the one in force", () => {
    const rt = rig(`{ globals: { palette: 'nord' } }`);
    openPicker(rt, "theme");
    const random = rt.linkOn("theme", SWATCHES_RANDOM);
    const [key, value] = writesOf(random.url)[0]!;
    expect(key).toBe("theme");
    expect(THEMES).toContain(value);
    expect(value).not.toBe("nord");
    rt.click(random.url);
    expect(rt.sessionState.get(SID, "theme")).toBe(value);
    rt.dispose();
  });

  test("a swatch applies its theme and the row stays where it is", () => {
    const rt = rig(`{ globals: { palette: 'nord' } }`);
    openPicker(rt, "theme");
    const row = swatchLinks(rt.render());
    const other = links(rt.render()).find(
      (l) =>
        /▀▀▀/u.test(stripAnsi(l.text)) &&
        stripAnsi(l.text) !== "[▀▀▀]" &&
        effectsOf(l.url).some((e) => e.args[1] === "theme"),
    )!;
    expect(writesOf(other.url)).toHaveLength(1);
    const picked = writesOf(other.url)[0]![1]!;
    rt.click(other.url);
    expect(rt.sessionState.get(SID, "theme")).toBe(picked);
    expect(swatchLinks(rt.render()).map((c) => c.writes)).toEqual(row.map((c) => c.writes));
    rt.dispose();
  });

  test("opening the theme's swatches closes the gear, and the gear's lists open inside it", () => {
    const rt = rig(`{ globals: { palette: 'nord' } }`);
    openPicker(rt, "style");
    // The style list is open, and so is the gear holding it.
    expect(rt.sink.has("candybar.list.style.0")).toBe(true);
    expect(rt.sink.has("candybar.style")).toBe(true);
    rt.clickWriting(PICKERS, "candybar.apply.theme");
    expect(rt.sink.has("candybar.style")).toBe(false);
    expect(rt.sink.has("candybar.list.theme.0")).toBe(true);
    rt.dispose();
  });
});

describe("randomOther", () => {
  test("never names the option in force, and reaches every other", () => {
    for (const count of [2, 3, 7, 40]) {
      for (const centre of [0, count - 1]) {
        const seen = new Set<number>();
        for (let seed = 0; seed < 4000; seed++) {
          const pick = randomOther(Date.UTC(2026, 9, 15) + seed * 1000, count, centre);
          expect(pick).not.toBe(centre);
          expect(pick).toBeGreaterThanOrEqual(0);
          expect(pick).toBeLessThan(count);
          seen.add(pick);
        }
        expect([count, centre, seen.size]).toEqual([count, centre, count - 1]);
      }
    }
    // One option has no other: the pick is that option.
    expect(randomOther(12345, 1, 0)).toBe(0);
  });
});

// brandon-theme-picker-bgw.7g6: which role each row wears is a setting in the
// ⚙ config row, chosen like every display setting beside it.
describe("the variation control", () => {
  test("▶ applies the next variation in this session and the bar's closed cells recolour", () => {
    const rt = rig(`{ globals: { palette: 'nord' } }`);
    openPicker(rt, "variation");
    expect(stripAnsi(rt.render())).toContain(`${CAROUSEL_PREV} 🎼 variation ${CAROUSEL_NEXT}`);
    // Row 1 (directory) and row 2 (model) under the default.
    const before = ["directory", "model"].map((n) => rt.sink.get(n)![0]!.style);
    const trial = effectsOf(rt.linkOn("variation", CAROUSEL_NEXT).url);
    expect(trial.map((e) => [e.verb, e.args[1], e.args[2]])).toEqual([
      ["set-state", "variation", "duo"],
    ]);
    rt.click(rt.linkOn("variation", CAROUSEL_NEXT).url);
    expect(rt.sessionState.get(SID, "variation")).toBe("duo");
    const after = ["directory", "model"].map((n) => rt.sink.get(n)![0]!.style);
    expect(after[0]).not.toEqual(before[0]);
    expect(after[1]).not.toEqual(before[1]);
    rt.dispose();
  });
});

// candybar-theme-colours-6fq5.e5n: which of its role's shades each cell wears
// is a setting behind the theme's ⚙, beside the variation.
describe("the shade control", () => {
  test("▶ turns the dial one position in this session and the bar's closed cells recolour", () => {
    const rt = rig(`{ globals: { palette: 'nord' } }`);
    openPicker(rt, "shade");
    expect(stripAnsi(rt.render())).toContain(`${CAROUSEL_PREV} 🔆 shade ${CAROUSEL_NEXT}`);
    const before = ["directory", "model"].map((n) => rt.sink.get(n)![0]!.style);
    const trial = effectsOf(rt.linkOn("shade", CAROUSEL_NEXT).url);
    expect(trial.map((e) => [e.verb, e.args[1], e.args[2]])).toEqual([
      ["set-state", "shade", "brighter"],
    ]);
    rt.click(rt.linkOn("shade", CAROUSEL_NEXT).url);
    expect(rt.sessionState.get(SID, "shade")).toBe("brighter");
    const after = ["directory", "model"].map((n) => rt.sink.get(n)![0]!.style);
    expect(after[0]).not.toEqual(before[0]);
    expect(after[1]).not.toEqual(before[1]);
    rt.dispose();
  });
});

// brandon-menu-ia-q30.5y4: "make users set them in the config file."
describe("colour depth is set in the config file, not the menu", () => {
  test("no link on the bar or in the ⚙ config tab writes its key", () => {
    const rt = rig(`{}`);
    rt.render();
    rt.clickText("🍫");
    rt.clickText("⚙ config");
    const rendered = rt.render();
    expect(stripAnsi(rendered)).not.toMatch(/🔣|🌈/u);
    const writers = links(rendered).filter((l) =>
      effectsOf(l.url).some((e) =>
        e.args[1] === "colorCompatibility",
      ),
    );
    expect(writers).toEqual([]);
    rt.dispose();
  });
});

// The preview's rows, as the labels each draws: the lines after the list of
// presets (the body's first row, under the control's ◀ label ▶), up to the
// preset actions or the menu's tab strip below the body.
function previewLabels(rendered: string): string[][] {
  const lines = stripAnsi(rendered).split("\n");
  const ring = lines.findIndex((l) => l.includes(PRESET_CONTROL));
  const rows: string[][] = [];
  for (const line of lines.slice(ring + 2)) {
    // The preview's rows end where the ring's body goes on to the preset
    // actions (brandon-save-undo-bwi.o6u), or where the body ends: the
    // menu's tab strip is the next line.
    if (line.includes(`${PRESET_DELETE_GLYPH} delete`) || line.includes("⚡ session")) break;
    rows.push(line.split(/\s+/).filter((word) => /\w/.test(word)));
  }
  return rows;
}

describe("the preset control's list carries the layout beneath it", () => {
  test("every bundled preset's rows, from its resolved root", () => {
    const config = parseAndValidate("<user>", "{}", ALLOWED, DEFAULT_DSL_CONFIG);
    const registry = new SourceRegistry(processLauncher, new VariableStore(), "");
    const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
    // Every segment but edit mode's chrome, which edit mode alone shows.
    const content = (node: CompiledNode): boolean =>
      node.kind === "container" || !node.name.startsWith(EDIT_NS);
    const rows = Object.fromEntries(
      [...compiled.roots].map(([name, root]) => [
        name,
        layoutRows(root, content).map((row) => row.map((s) => s.name)),
      ]),
    );
    expect(rows).toEqual({
      default: [
        ["candybar.menu", "candybar.fps", "host", "directory", "gitaculous"],
        ["model", "context", "autocompact", "cacheTimer", "block", "weekly", "activity"],
      ],
      compact: [["candybar.menu", "candybar.fps", "directory", "gitaculous", "context"]],
      verbose: [
        ["candybar.menu", "candybar.fps", "directory", "gitaculous", "gitPr"],
        ["model", "context", "autocompact", "cacheTimer", "block", "weekly", "burnrate"],
        ["speed", "tokenSparkline"],
      ],
      zen: [["candybar.menu", "candybar.fps", "directory", "context"]],
      git: [
        ["candybar.menu", "candybar.fps", "host", "directory", "gitaculous", "gitPr"],
        ["model", "context", "activity"],
      ],
      usage: [
        ["candybar.menu", "candybar.fps", "model", "context", "autocompact", "cacheTimer"],
        ["block", "weekly", "burnrate"],
        ["session", "today", "speed", "tokenSparkline"],
      ],
      dense: [
        [
          "candybar.menu",
          "candybar.fps",
          "host",
          "directory",
          "gitaculous",
          "model",
          "context",
          "autocompact",
          "cacheTimer",
          "block",
          "weekly",
          "session",
          "activity",
        ],
      ],
    });
    registry.dispose();
  });

  test.each(presetNames(DEFAULT_DSL_CONFIG.presets))(
    "%s: the preview draws the segments the closed bar draws, row for row, in the colours they wear",
    (preset) => {
      const rt = rig(`{}`);
      rt.sessionState.set(SID, "preset", preset);
      const closed = rt.render();
      const drawn = [...rt.sink.keys()];
      const closedStyle = (name: string) => bgHex(rt.sink.get(name)![0]!.style);
      const tints = Object.fromEntries(drawn.map((n) => [blockLabel(n), closedStyle(n)]));
      // Which line of the closed bar each drawn segment sits on: segments are
      // drawn in order, so each is found at or after the one before it.
      const barLines = stripAnsi(closed).split("\n");
      const barRows: string[][] = barLines.map(() => []);
      let line = 0;
      let col = 0;
      for (const name of drawn) {
        const text = rt.sink.get(name)!.map((c) => c.plain).join("").trim();
        while (barLines[line]!.indexOf(text, col) < 0) [line, col] = [line + 1, 0];
        col = barLines[line]!.indexOf(text, col) + text.length;
        barRows[line]!.push(blockLabel(name));
      }
      openPicker(rt, "preset");
      const labels = previewLabels(rt.render());
      expect(labels).toEqual(barRows);
      // Each block wears what its segment wears on the closed bar; every
      // segment here authors no `bg:` under this payload's calm values.
      const preview = rt.sink.get("candybar.list.preset.1")!;
      const blockBg = Object.fromEntries(
        preview.flatMap((cell) =>
          cell.spans.map((span) => [
            cell.plain.slice(span.start, span.end).trim(),
            bgHex(span.style),
          ]),
        ),
      );
      for (const label of labels.flat()) {
        expect([label, blockBg[label]]).toEqual([label, tints[label]]);
      }
      rt.dispose();
    },
  );

  test("edit mode's +/- and reset banner are not part of the arrangement the preview draws", () => {
    const rt = rig(`{}`);
    openPicker(rt, "preset");
    const outside = previewLabels(rt.render());
    rt.sessionState.set(SID, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    rt.sessionState.set(SID, EDIT_LIVE_KEY, "open");
    const rendered = rt.render();
    // Edit mode is on: its chrome is on the bar the preview describes.
    expect([...rt.sink.keys()].some((name) => name.startsWith(EDIT_NS))).toBe(true);
    expect(previewLabels(rendered)).toEqual(outside);
    rt.dispose();
  });

  test("in edit mode's names view the preview draws every placed segment, shown or not", () => {
    const rt = rig(`{}`);
    openPicker(rt, "preset");
    rt.sessionState.set(SID, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    // Every segment the default preset places, in order: the labels stand in
    // for them whether or not this payload renders them (it renders no host,
    // context, cache timer, or activity).
    const placed = [
      ["menu", "fps", "host", "directory", "gitaculous"],
      ["model", "context", "autocompact", "cacheTimer", "block", "weekly", "activity"],
    ];
    expect(previewLabels(rt.render())).toEqual(placed);
    rt.dispose();
  });

  test("in the names view a placement with its own id stands for its segment", () => {
    const rt = rig(`{ root: { rows: { status: { h: ['model', { seg: 'model', id: 'model-2' }] } } } }`);
    openPicker(rt, "preset");
    rt.sessionState.set(SID, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
    const rendered = rt.render();
    expect(stripAnsi(rendered)).not.toContain("⚠");
    expect(previewLabels(rendered)[1]).toEqual(["model", "model"]);
    rt.dispose();
  });

  test("▶ rotates through every preset and wraps, the preview following the preset it applied", () => {
    const rt = rig(`{}`);
    openPicker(rt, "preset");
    const seen: string[] = [];
    const rowCounts: number[] = [];
    const names = presetNames(DEFAULT_DSL_CONFIG.presets);
    for (let i = 0; i < names.length; i++) {
      rt.click(rt.linkOn("preset", CAROUSEL_NEXT).url);
      seen.push(rt.sessionState.get(SID, "preset")!);
      rowCounts.push(previewLabels(rt.render()).length);
    }
    // ▶ steps through the domain in order and wraps back to where it started.
    expect(seen).toEqual([...names.slice(1), names[0]]);
    // Compact, zen and dense are one row; the others stack two (verbose's
    // third row and usage's block/weekly/burnrate row are gated off by this
    // payload, which carries no rate-limit window). The full per-preset layouts
    // are pinned by "every bundled preset's rows" above.
    expect(rowCounts).toEqual([1, 2, 1, 2, 2, 1, 2]);
    rt.dispose();
  });

  test("labels shrink alike, down to one column, for a row that does not fit", () => {
    const row = ["candybar.menu", "directory", "gitaculous"].map((name) => ({
      name,
      address: [],
      palette: getThemePalette("nord")!,
    }));
    // Full labels: menu(4) directory(9) gitaculous(10), each +2 = 29.
    expect(labelBudget([row], 29)).toBe(10);
    expect(labelBudget([row], 28)).toBe(9);
    expect(labelBudget([row], 3)).toBe(1);
    const text = renderLayoutPreview([row], DEFAULT_DECOR, ColorDepth.TRUECOLOR, 20).plain;
    expect(text).toBe(" menu  dire…  gita… ");
  });
});

// A style's background, as hex, or undefined when it paints none.
const bgHex = (style: TextStyle | undefined): string | undefined =>
  style === undefined ? undefined : resolvedStyle(style).bgcolor?.value?.hex;

// The colours a rendered fragment list draws backgrounds in.
const backgrounds = (cells: readonly RichText[]): Set<string> =>
  new Set(
    cells
      .flatMap((cell) => [cell.style, ...cell.spans.map((span) => span.style)])
      .map(bgHex)
      .filter((hex): hex is string => hex !== undefined),
  );

// The background `text` is drawn on: the last span over its first character
// that paints one, else its fragment's own.
const bgUnder = (cells: readonly RichText[], text: string): string | undefined => {
  for (const cell of cells) {
    const at = cell.plain.indexOf(text);
    if (at === -1) continue;
    const painted = cell.spans
      .filter((span) => span.start <= at && at < span.end)
      .map((span) => bgHex(span.style))
      .filter((hex): hex is string => hex !== undefined);
    return painted.at(-1) ?? bgHex(cell.style);
  }
  return undefined;
};

describe("the preview is the bar's own colours", () => {
  const IDENTITY: ThemeKey = {
    hueShift: 0,
    chromaScale: 1,
    lightnessScale: 1,
    lightnessShift: 0,
  };

  // Every colour a closed cell can wear under the default decor at a depth:
  // each of its hues at every tone of that hue's window there.
  const closedColours = (palette: Palette, drawnAt: ColorDepth): string[] =>
    DEFAULT_DECOR.variation.hues.flatMap((hue) =>
      windowAt(palette, hue, DEFAULT_DECOR.shade, drawnAt).map((shade) => decorEntryColour(palette, { hue, shade }).hex),
    );

  // A depth deals a closed cell its hue's window there, which can hold a rung
  // the dial does not name: where the depth draws two of the dial's tones
  // alike, the window widens along the ladder (catppuccin-mocha and default
  // at ansi widen both of the default's hues; dracula at 256 widens one back
  // to the dial's three).
  test.each([
    ["nord", "truecolor"],
    ["gruvbox", "truecolor"],
    ["rose-pine-dawn", "truecolor"],
    ["textual-light", "truecolor"],
    ["catppuccin-mocha", "ansi"],
    ["default", "ansi"],
    ["dracula", "256"],
  ] as const)(
    "%s at %s: the preview shows every colour a closed cell can wear, and its open swatch is the open door's",
    (theme, depth) => {
      const rt = rig(`{ globals: { palette: '${theme}', colorCompatibility: '${depth}' } }`);
      openPicker(rt, "theme");
      const palette = transposePalette(getThemePalette(theme)!, IDENTITY);
      // Row 0 is the swatch row; the demo is row 1.
      const preview = rt.sink.get("candybar.list.theme.1")!;
      const drawn = backgrounds(preview);
      // Every decoration a closed cell can wear at the depth is a swatch.
      expect(closedColours(palette, drawnDepth(depth)).filter((hex) => !drawn.has(hex))).toEqual([]);
      // Its open swatch is the colour the open door is drawn in.
      expect(bgUnder(preview, "▾ open")).toBe(bgHex(rt.sink.get("candybar.menu")![0]!.style));
      // Every closed bar cell that authors no meaning wears a preview tint.
      for (const name of ["directory", "model", "gitaculous"]) {
        const cells = rt.sink.get(name);
        if (cells === undefined) continue;
        expect([name, drawn.has(bgHex(cells[0]!.style)!)]).toEqual([name, true]);
      }
      rt.dispose();
    },
  );

  // [LAW:verifiable-goals] candybar-joiners-e5r4.cfm: the preview deals every
  // tone of each hue's window, so where a depth widens a window back to the
  // dial's count the preview shows that count.
  test("dracula at 256: the accent's window, two of whose tones the depth draws alike, widens back to three, and the preview shows all three", () => {
    const rt = rig(`{ globals: { palette: 'dracula', colorCompatibility: '256' } }`);
    openPicker(rt, "theme");
    const palette = transposePalette(getThemePalette("dracula")!, IDENTITY);
    const window = windowAt(palette, "accent", DEFAULT_DECOR.shade, ColorDepth.EIGHT_BIT);
    const named: readonly string[] = DEFAULT_DECOR.shade.tones;
    expect([window.length, window.filter((tone) => !named.includes(tone)).length]).toEqual([named.length, 1]);
    const drawn = backgrounds(rt.sink.get("candybar.list.theme.1")!);
    expect(window.map((shade) => decorEntryColour(palette, { hue: "accent", shade }).hex).filter((hex) => !drawn.has(hex))).toEqual([]);
    rt.dispose();
  });

  test("under alt the open swatch is still the door's colour, though the door's row turns between two roles", () => {
    // textual-dark's navy secondary and orange accent: the pure accent stands
    // off a row of secondary alone, and no colour stands off the door's row,
    // which turns to the accent after three cells — so a preview standing on
    // anything but the door's own row shows an open colour the bar never draws.
    const rt = rig(`{ globals: { palette: 'textual-dark', variation: 'alt' } }`);
    openPicker(rt, "theme");
    expect(bgUnder(rt.sink.get("candybar.list.theme.1")!, "▾ open")).toBe(bgHex(rt.sink.get("candybar.menu")![0]!.style));
    rt.dispose();
  });

  test("under a style the preview is the styled palette the bar wears — the style list previews it", () => {
    const rt = rig(`{ globals: { palette: 'gruvbox' } }`);
    openPicker(rt, "style");
    rt.click(rt.linkOn("style", CAROUSEL_NEXT).url);
    const look = rt.sessionState.get(SID, "style")!;
    expect(look).not.toBe("none");
    // [LAW:behavior-not-structure] rich-js `transposePalette` directly, never
    // the render's memoized `transposedPalette`: the function under test
    // cannot be the oracle that checks it.
    const palette = transposePalette(
      getThemePalette("gruvbox")!,
      rt.config.styles[look]!,
    );
    const preview = rt.sink.get("candybar.list.style.1")!;
    const drawn = backgrounds(preview);
    expect(closedColours(palette, ColorDepth.TRUECOLOR).filter((hex) => !drawn.has(hex))).toEqual([]);
    expect(drawn.has(bgHex(rt.sink.get("directory")![0]!.style)!)).toBe(true);
    expect(bgUnder(preview, "▾ open")).toBe(bgHex(rt.sink.get("candybar.menu")![0]!.style));
    rt.dispose();
  });

  test("the endcaps list has no preview row: an endcaps shape is not a palette", () => {
    const rt = rig(`{}`);
    openPicker(rt, "endcaps");
    expect(rt.sink.has("candybar.list.endcaps.0")).toBe(true);
    expect(rt.sink.has("candybar.list.endcaps.1")).toBe(false);
    rt.dispose();
  });
});
