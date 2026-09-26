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

import { ColorDepth, getThemePalette } from "@promptctl/rich-js";
import { RichText as RichTextValue } from "@promptctl/rich-js";
import type { RichText, Style, ThemeKey } from "@promptctl/rich-js";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { SessionState } from "../src/daemon/session-state";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import {
  effectiveCharset,
  effectiveColorCompatibility,
  listResolvablePaletteNames,
} from "../src/themes/policy";
import type {
  Charset,
  ColorCompatibility,
  StripStyle,
} from "../src/themes/policy";
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
import { renderStripCells } from "../src/render/strip";
import {
  blockLabel,
  labelBudget,
  renderLayoutPreview,
} from "../src/render/layout-preview";
import { layoutRows, type CompiledNode } from "../src/dsl/node-registry";
import { sharedMenuStateKey } from "../src/config/menu-keys";
import { EDIT_MODE_KEY, EDIT_MODE_OPEN } from "../src/config/loader/edit-mode";
import { EDIT_NS } from "../src/config/loader/reserved-namespace";
import { effectivePresetName } from "../src/config/presets";
import type { ValidatedConfig } from "../src/config/dsl-types";

const ALLOWED = new Set(listResolvablePaletteNames());
const SID = "ef6";

function opts(
  width: number,
  padding: number,
  style: StripStyle,
  charset: Charset = "unicode",
  colorCompatibility: ColorCompatibility = "truecolor",
) {
  return { style, colorCompatibility, wrap: true, padding, charset, width };
}

// One rig over the real cascade: parse on the bundled default (where the
// settings menu is synthesized), install the derived gates, render through
// renderDsl with the session's theme and look resolved the way the daemon
// resolves them, and click through the real verb handlers.
function rig(
  source: string,
  width = 200,
  padding = 0,
  style: StripStyle = "powerline",
) {
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
    const preset = effectivePresetName(
      sessionState.get(SID, "preset"),
      config.globals.preset,
      config.presets,
    );
    const charset = effectiveCharset(
      undefined,
      sessionState.get(SID, "charset"),
      config.globals.charset,
    );
    const depth = effectiveColorCompatibility(
      undefined,
      sessionState.get(SID, "colorCompatibility"),
      config.globals.colorCompatibility,
    );
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
        style: { effective: sessionState.get(SID, "style") ?? style },
        preset: { effective: preset },
        autoWrap: { effective: true },
        padding: { effective: padding },
        charset: { effective: charset },
        colorCompatibility: { effective: depth },
      },
      opts(width, padding, style, charset, depth),
      { perSegmentSink: sink },
      {
        theme: resolveThemeSelection(
          undefined,
          sessionState.get(SID, "theme"),
          config.globals.palette,
        ),
        preset,
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

  test("a value outside the domain rotates from the first option, and nothing reads as current", () => {
    const rt = rig(CAROUSEL_ONLY);
    rt.sessionState.set(SID, "pick", "x");
    rt.render();
    const ring = rt.sink.get("ring")!;
    const bold = ring.flatMap((cell) =>
      cell.spans
        .filter((span) => typeof span.style === "object" && span.style.bold)
        .map((span) => cell.plain.slice(span.start, span.end)),
    );
    expect(bold).toEqual([]);
    rt.clickText(CAROUSEL_NEXT);
    expect(rt.sessionState.get(SID, "pick")).toBe("b");
    rt.dispose();
  });

  test("a key no variable reads back is a loud error naming the variable to declare", () => {
    const rt = rig(`{
      actions: { choose: { set: 'unread', from: ['a', 'b'] } },
      segments: { ring: { template: '{{ carousel "choose" }}' } },
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
        `{ segments: { ring: { template: '{{ carousel "noSuchApply" }}' } },
           root: { rows: { identity: { h: ['ring'] }, status: { h: [] } } } }`,
        ALLOWED,
        DEFAULT_DSL_CONFIG,
      ),
    ).toThrow(/unknown action "noSuchApply" \(in a picker, menu or carousel\)/);
  });

  test("a carousel over the wrong kind of action names the carousel, not the picker", () => {
    const rt = rig(`{
      variables: { pick: { kind: 'state', key: 'pick', default: 'a' } },
      actions: { choose: { set: 'pick', cycle: ['a', 'b'] } },
      segments: { ring: { template: '{{ carousel "choose" }}' } },
      root: { rows: { identity: { h: ['ring'] }, status: { h: [] } } },
    }`);
    expect(stripAnsi(rt.render())).toContain(
      `carousel references action "choose"`,
    );
    rt.dispose();
  });

  test("neighbours come in symmetric pairs, only while they fit, never repeating an option", () => {
    const names = ["aa", "bb", "cc", "dd", "ee", "ff", "gg"];
    const ring = (d: number) => names[((d % 7) + 7) % 7]!;
    // ◀ aa ▶ = 6 cols; each level adds two names and two spaces = 6.
    expect(neighbourLevels(ring, 7, 6, 6, Infinity)).toBe(0);
    expect(neighbourLevels(ring, 7, 6, 11, Infinity)).toBe(0);
    expect(neighbourLevels(ring, 7, 6, 12, Infinity)).toBe(1);
    expect(neighbourLevels(ring, 7, 6, 1000, Infinity)).toBe(3);
    // Two options: the one neighbour is both ◀ and ▶, so the ring shows none.
    expect(neighbourLevels(ring, 2, 6, 1000, Infinity)).toBe(0);
    // The author's cap bounds the levels; width still decides within it.
    expect(neighbourLevels(ring, 7, 6, 1000, 0)).toBe(0);
    expect(neighbourLevels(ring, 7, 6, 1000, 2)).toBe(2);
    expect(neighbourLevels(ring, 7, 6, 12, 2)).toBe(1);
  });
});

// The ring's line: one value between the arrows — the padding stepper's
// "◀ padding 0 ▶" carries two.
const RING = new RegExp(`${CAROUSEL_PREV} \\S+ ${CAROUSEL_NEXT}`);

// The door, then ⚙ config, then one control's carousel.
const PICKERS = sharedMenuStateKey("settings.pickers");
function openCarousel(rt: ReturnType<typeof rig>, control: string): void {
  rt.render();
  rt.clickText("🍫");
  // The preset control sits on the tray itself; the rest behind ⚙ config.
  if (control !== "preset") rt.clickText("⚙ config ▸");
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

  // The carousel and the rows beneath it are the rows of an open body, each
  // led by the body's ✕ as a cell of its own; all of them fit the row that ✕
  // leaves them, at any padding and any strip shape, so the terminal never
  // breaks a row away from its ✕ — and nothing else on the bar overflows.
  test.each(
    (["theme", "preset"] as const).flatMap((control) =>
      (["powerline", "capsule", "plain"] as const).flatMap((style) =>
        [0, 1, 2].map((padding) => [control, style, padding] as const),
      ),
    ),
  )("every row of the open %s carousel fits its terminal (%s, padding %i)", (control, style, padding) => {
    for (let width = 40; width <= 160; width += 3) {
      const rt = rig(`{ globals: { palette: 'nord' } }`, width, padding, style);
      openCarousel(rt, control);
      const lines = stripAnsi(rt.render()).split("\n");
      const ring = lines.findIndex((l) => RING.test(l));
      // The ring, then every line the rows beneath it draw (the preset
      // preview draws one per row of the layout), each led by the ✕.
      const beneath = rt.sink.get(`settings.carousel.${control}.0`)!.length;
      const body = lines.slice(ring, ring + 1 + beneath);
      expect([width, body.filter((l) => !/^\W*✕/u.test(l))]).toEqual([width, []]);
      expect(body).toHaveLength(1 + beneath);
      const over = lines.filter((l) => new RichTextValue(l).cellLength > width);
      expect([width, over]).toEqual([width, []]);
      rt.dispose();
    }
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

describe("glyphs and colour depth sit in the settings menu, not on the bar", () => {
  test("the bar carries no terminal drawer; ⚙ config holds both controls", () => {
    const rt = rig(`{}`);
    expect(stripAnsi(rt.render())).not.toContain("terminal");
    rt.clickText("🍫");
    rt.clickText("⚙ config ▸");
    const text = stripAnsi(rt.render());
    expect(text).toContain("🔣 unicode");
    expect(text).toContain("🌈 truecolor");
    rt.dispose();
  });

  // They describe the terminal a session runs in, so they follow persist?
  // like every control beside them: unchecked, ▶ tries the next value in this
  // session alone and the bar re-centres on it; checked, the same ▶ writes the
  // config file and releases the session's pick.
  test.each([
    // [key, current, the trial ▶, the committing ▶ from the trial value]
    ["charset", "unicode", "ascii", "unicode"],
    ["colorCompatibility", "truecolor", "256", "ansi"],
  ])(
    "%s follows persist?",
    (key, current, next, after) => {
      const rt = rig(`{}`);
      rt.render();
      rt.clickText("🍫");
      rt.clickText("⚙ config ▸");
      rt.clickWriting(PICKERS, `settings.apply.${key}`);
      expect(stripAnsi(rt.render())).toMatch(
        new RegExp(`${CAROUSEL_PREV} ${current} ${CAROUSEL_NEXT}`),
      );
      const trial = effectsOf(rt.linkOn(key, CAROUSEL_NEXT).url);
      expect(trial.map((e) => [e.verb, e.args[1], e.args[2]])).toEqual([
        ["set-state", key, next],
      ]);
      rt.clickWriting(key, next);
      expect(stripAnsi(rt.render())).toMatch(
        new RegExp(`${CAROUSEL_PREV} ${next} ${CAROUSEL_NEXT}`),
      );
      rt.clickWriting("settings.persist", "true");
      const commit = effectsOf(rt.linkOn(key, CAROUSEL_NEXT).url);
      expect(
        commit.map((e) => [e.verb, e.args[1], e.args[2], e.args[3]]),
      ).toEqual([["set-config", key, after, key]]);
      rt.dispose();
    },
  );

  test.each(["charset", "colorCompatibility"])(
    "%s's ↺ forgets the durable default",
    (key) => {
      const rt = rig(`{}`);
      rt.render();
      rt.clickText("🍫");
      rt.clickText("⚙ config ▸");
      const reset = links(rt.render()).filter((l) =>
        effectsOf(l.url).some(
          (e) => e.verb === "reset-config" && e.args[1] === key,
        ),
      );
      expect(reset.map((l) => stripAnsi(l.text))).toEqual(["↺"]);
      rt.dispose();
    },
  );
});

// The preview's rows, as the labels each draws: the lines after the ring, led
// by the body's ✕, up to the next line the body does not lead.
function previewLabels(rendered: string): string[][] {
  const lines = stripAnsi(rendered).split("\n");
  const ring = lines.findIndex((l) => RING.test(l));
  const rows: string[][] = [];
  for (const line of lines.slice(ring + 1)) {
    if (!/^\W*✕/u.test(line)) break;
    rows.push(line.split(/\s+/).filter((word) => /\w/.test(word)));
  }
  return rows;
}

describe("the preset control is a carousel with the layout beneath it", () => {
  test("every bundled preset's rows, from its resolved root", () => {
    const config = parseAndValidate("<user>", "{}", ALLOWED, DEFAULT_DSL_CONFIG);
    const registry = new SourceRegistry(new VariableStore(), "", undefined);
    const compiled = registerDslConfig(config, registry, { cwd: "/tmp" });
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
        ["settings.menu", "host", "directory", "gitaculous"],
        ["model", "context", "cacheTimer", "block", "weekly", "activity"],
      ],
      compact: [["settings.menu", "directory", "git", "context"]],
      verbose: [
        ["settings.menu", "directory", "gitaculous", "gitPr"],
        ["model", "context", "cacheTimer", "block", "weekly", "burnrate"],
        ["speed", "tokenSparkline"],
      ],
    });
    registry.dispose();
  });

  test.each(["default", "compact", "verbose"])(
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
      openCarousel(rt, "preset");
      const labels = previewLabels(rt.render());
      expect(labels).toEqual(barRows);
      // Each block wears what its segment wears on the closed bar; every
      // segment here authors no `bg:` under this payload's calm values.
      const preview = rt.sink.get("settings.carousel.preset.0")!;
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
    openCarousel(rt, "preset");
    const outside = previewLabels(rt.render());
    rt.sessionState.set(SID, EDIT_MODE_KEY, EDIT_MODE_OPEN);
    const rendered = rt.render();
    // Edit mode is on: its chrome is on the bar the preview describes.
    expect([...rt.sink.keys()].some((name) => name.startsWith(EDIT_NS))).toBe(true);
    expect(previewLabels(rendered)).toEqual(outside);
    rt.dispose();
  });

  test("▶ rotates through every preset and wraps, the preview following the preset it applied", () => {
    const rt = rig(`{}`);
    openCarousel(rt, "preset");
    const seen: string[] = [];
    const rowCounts: number[] = [];
    for (let i = 0; i < 3; i++) {
      rt.click(rt.linkOn("preset", CAROUSEL_NEXT).url);
      seen.push(rt.sessionState.get(SID, "preset")!);
      rowCounts.push(previewLabels(rt.render()).length);
    }
    expect(seen).toEqual(["compact", "verbose", "default"]);
    // Compact is one row; the others stack status under identity (verbose's
    // third row is gated off by this payload). The full per-preset layouts are
    // pinned by "every bundled preset's rows" above.
    expect(rowCounts).toEqual([1, 2, 2]);
    rt.dispose();
  });

  test("labels shrink alike, down to one column, for a row that does not fit", () => {
    const row = ["settings.menu", "directory", "gitaculous"].map((name) => ({
      name,
      address: [],
      palette: getThemePalette("nord")!,
    }));
    // Full labels: menu(4) directory(9) gitaculous(10), each +2 = 29.
    expect(labelBudget([row], 29)).toBe(10);
    expect(labelBudget([row], 28)).toBe(9);
    expect(labelBudget([row], 3)).toBe(1);
    const text = renderLayoutPreview([row], ColorDepth.TRUECOLOR, 20).plain;
    expect(text).toBe(" menu  dire…  gita… ");
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
        previewSwatches(palette, ColorDepth.TRUECOLOR).flat().map((s) => s.colour.hex),
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
      previewSwatches(palette, ColorDepth.TRUECOLOR).flat().map((s) => s.colour.hex),
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

// [LAW:verifiable-goals] brandon-theme-picker-bgw.exj — the bundled
// `themeSwitcher` segment: `◀ <theme> ▶` on the bar itself, so the whole bar
// stays visible while stepping through themes. Read by segment name off the
// per-segment sink and serialized through the strip serializer the bar uses,
// never by position in the bar (every row leads with the settings door).
describe("the bundled themeSwitcher segment steps the session theme on the bar", () => {
  const THEMES = listResolvablePaletteNames();
  // Placed on the status row, so it stays on the bar while the settings menu
  // opens inline over the door's (identity) row.
  const PLACED = `{ globals: { palette: 'nord' },
    root: { rows: { status: { h: ['model', 'themeSwitcher'] } } } }`;

  const bytesOf = (rt: ReturnType<typeof rig>, segment: string): string =>
    renderStripCells(rt.sink.get(segment)!, opts(200, 0, "powerline"));
  const linkAt = (bytes: string, glyph: string) =>
    links(bytes).find((l) => stripAnsi(l.text) === glyph)!;
  const switcher = (rt: ReturnType<typeof rig>) => {
    const bytes = bytesOf(rt, "themeSwitcher");
    return {
      text: rt.sink.get("themeSwitcher")!.map((cell) => cell.plain).join(""),
      prev: writesOf(linkAt(bytes, CAROUSEL_PREV).url),
      next: writesOf(linkAt(bytes, CAROUSEL_NEXT).url),
    };
  };

  test("with no session pick it shows the theme the bar wears, not the domain's first", () => {
    const rt = rig(PLACED);
    rt.render();
    // nord is not the first theme, so a ring centred on no value would show
    // THEMES[0] instead.
    expect(THEMES[0]).not.toBe("nord");
    const i = THEMES.indexOf("nord");
    expect(switcher(rt)).toEqual({
      text: `${CAROUSEL_PREV} nord ${CAROUSEL_NEXT}`,
      prev: [["theme", THEMES[i - 1]!]],
      next: [["theme", THEMES[i + 1]!]],
    });
    rt.dispose();
  });

  test("◀ writes the previous theme and ▶ the next, wrapping at the first and last", () => {
    const rt = rig(PLACED);
    const n = THEMES.length;
    for (const i of [0, 1, n - 1]) {
      rt.sessionState.set(SID, "theme", THEMES[i]!);
      rt.render();
      expect(switcher(rt)).toEqual({
        text: `${CAROUSEL_PREV} ${THEMES[i]} ${CAROUSEL_NEXT}`,
        prev: [["theme", THEMES[(i - 1 + n) % n]!]],
        next: [["theme", THEMES[(i + 1) % n]!]],
      });
    }
    rt.dispose();
  });

  test("a click applies through the real gate and re-centres, opening nothing", () => {
    const rt = rig(PLACED);
    const rows = stripAnsi(rt.render()).split("\n").length;
    const i = THEMES.indexOf("nord");
    rt.click(linkAt(bytesOf(rt, "themeSwitcher"), CAROUSEL_NEXT).url);
    expect(rt.sessionState.get(SID, "theme")).toBe(THEMES[i + 1]);
    expect(switcher(rt).text).toBe(
      `${CAROUSEL_PREV} ${THEMES[i + 1]} ${CAROUSEL_NEXT}`,
    );
    // Nothing opened: the bar has exactly as many rows as before the click.
    expect(stripAnsi(rt.render()).split("\n").length).toBe(rows);
    rt.dispose();
  });

  test("a theme picked through the settings menu is the theme the segment shows", () => {
    const rt = rig(PLACED);
    openCarousel(rt, "theme");
    rt.click(linkAt(bytesOf(rt, "settings.carousel.theme"), CAROUSEL_NEXT).url);
    const picked = rt.sessionState.get(SID, "theme")!;
    expect(picked).toBe(THEMES[THEMES.indexOf("nord") + 1]);
    expect(switcher(rt).text).toBe(
      `${CAROUSEL_PREV} ${picked} ${CAROUSEL_NEXT}`,
    );
    rt.dispose();
  });

  test("the bundled segment is the carousel asked for no neighbours, over a plain session set", () => {
    expect(DEFAULT_DSL_CONFIG.segments.themeSwitcher!.template).toBe(
      '{{ carousel "stepTheme" 0 }}',
    );
    expect(DEFAULT_DSL_CONFIG.actions.stepTheme).toEqual({
      set: "theme",
      from: "themes",
    });
  });

  test.each([
    ["-1", "neighbours must be a whole number ≥ 0 (0 shows only ◀ CURRENT ▶), got -1"],
    // Not truncated to 1: the engine's int gate would, silently.
    ["1.5", "neighbours must be a whole number ≥ 0 (0 shows only ◀ CURRENT ▶), got 1.5"],
    // Not dropped: the engine repeats a trailing slot.
    ["0 2", "takes at most one neighbours count after the action name, got 2"],
  ])("neighbours %s is a loud render error", (args, message) => {
    const rt = rig(`{
      variables: { pick: { kind: 'state', key: 'pick', default: 'a' } },
      actions: { choose: { set: 'pick', from: ['a', 'b', 'c'] } },
      segments: { ring: { template: '{{ carousel "choose" ${args} }}' } },
      root: { rows: { identity: { h: ['ring'] }, status: { h: [] } } },
    }`);
    expect(stripAnsi(rt.render()).replace(/\s+/g, " ")).toContain(message);
    rt.dispose();
  });
});
