// [LAW:verifiable-goals] candybar-isolated-daemon-bfab.abb: `encodeAnsi` is the
// one path from a draw to bytes, and it writes what rich-js's own encoder writes
// for the segments the draw held. A rich-js bump that moves those bytes fails
// here. The comparison is asserted over synthesized colours and over real draws
// under motion, and each asserts its own reach, so neither can pass by drawing
// nothing. Bytes alone would not see a run holding a colour never drawn, since
// the encoder downgrades it again, so the runs' colours are asserted too; nor a
// second path writing the same bytes, so src is searched for one.

import fs from "node:fs";
import path from "node:path";

import {
  ColorDepth,
  ColorSpec,
  ControlType,
  DEFAULT_TERMINAL_THEME,
  EFFECT_CATALOGUE,
  Effected,
  FlexStrip,
  JOINERS,
  RichText,
  Segment,
  Style,
  render,
  resolveDestination,
  segmentsToString,
  type Destination,
  type LoopName,
  type Renderable,
} from "@promptctl/rich-js";

import {
  encodeAnsi,
  plainOf,
  runLines,
  type Attribute,
  type Run,
} from "../src/render/frame";
import { drawStripCells } from "../src/render/strip";
import { RENDER_THEME } from "../src/render/rich-theme";
import {
  COLOR_COMPATIBILITIES,
  type ColorCompatibility,
} from "../src/themes/policy";

const DEPTHS = COLOR_COMPATIBILITIES;
const LINK = "cc-candybar://dispatch/e=x";

// A blend's mix with an end only the terminal's theme fixes: two fixed ends
// collapse to plain RGB, so this is what a ColorBlend is.
const isBlend = (spec: ColorSpec | undefined): boolean =>
  spec?.type === ColorDepth.TRUECOLOR && spec.fixedValue === undefined;
const blends = (segments: readonly Segment[]): readonly Segment[] =>
  segments.filter((s) => isBlend(s.style?.color) || isBlend(s.style?.bgcolor));

const parse = ColorSpec.parse;
const COLORS: readonly (string | ColorSpec | undefined)[] = [
  undefined,
  "default",
  "red",
  "bright_cyan",
  "dark_orange",
  "color(3)",
  "color(17)",
  "color(244)",
  "#ff8800",
  "#00000000",
  "#33669980",
  "#f0f0f040",
  ColorSpec.blend(parse("red"), parse("#102030"), 0.25),
  ColorSpec.blend(parse("#a0b0c0"), parse("bright_blue"), 0.5),
  ColorSpec.blend(parse("red"), parse("blue"), 1 / 3),
  ColorSpec.blend(parse("color(200)"), parse("green"), 0.75),
];

// Every attribute on, then off, then all of them together: a style that sets
// one false writes nothing for it.
const ATTRIBUTES = Object.keys(new Style().attributes) as Attribute[];
const LOOKS: readonly Readonly<Partial<Record<Attribute, boolean>>>[] = [
  {},
  ...ATTRIBUTES.map((name) => ({ [name]: true })),
  ...ATTRIBUTES.map((name) => ({ [name]: false })),
  Object.fromEntries(ATTRIBUTES.map((name) => [name, true])),
];

// One line per foreground: each over every background, in turn with each look
// and with a link, with text that is wide, private-use or plain. What the
// encoder writes nothing for rides along, and trails the last line, where
// `Segment.splitLines` would make it a line of its own.
function grid(): Segment[] {
  const texts = ["x", "cell text", "🍫", ""];
  let at = 0;
  const cell = (color: (typeof COLORS)[number], bg: (typeof COLORS)[number]) => {
    at += 1;
    const style = new Style({
      color,
      bgcolor: bg,
      ...LOOKS[at % LOOKS.length],
      ...(at % 3 === 0 && { link: `${LINK}${at}` }),
    });
    return [
      new Segment(texts[at % texts.length]!, style),
      new Segment("", style),
      new Segment("", undefined, [[ControlType.BELL]]),
    ];
  };
  return [
    ...COLORS.flatMap((color) => [
      ...COLORS.flatMap((bg) => cell(color, bg)),
      new Segment("no style"),
      Segment.line(),
    ]),
    Segment.line(),
    new Segment("", new Style({ color: "red" })),
    new Segment("", undefined, [[ControlType.BELL]]),
  ];
}

const HOST = {};

// A strip as src/render/strip.ts draws one: every segment of `renderable` at
// `destination`, at `time`.
function drawn(
  renderable: Renderable,
  destination: Destination,
  time: number,
  width: number,
): Segment[] {
  return [
    ...render(renderable, {
      maxWidth: width,
      isTerminal: false,
      asciiOnly: false,
      theme: RENDER_THEME,
      colorSystem: destination.colorSystem,
      frame: { time, host: HOST },
      onStyleError: (error) => {
        throw error;
      },
    }),
  ];
}

// Standard, indexed and hex grounds and inks side by side, so the prism seams
// between them mix to ColorBlends. WIDTH wraps them.
const WIDTH = 30;
function cells(): RichText[] {
  const specs = [
    { color: "bright_white", bgcolor: "red", bold: true },
    { color: "black", bgcolor: "blue" },
    { color: "#f0d0a0", bgcolor: "color(200)", italic: true },
    { color: "color(17)", bgcolor: "#336699" },
    { color: "green", bgcolor: "#33669980", underline: true },
    { color: "#102030", bgcolor: "yellow", link: LINK },
  ];
  return specs.map(
    (style, i) =>
      new RichText(`cell ${i}`, {
        style: new Style(style),
        end: "",
        overflow: "ignore",
      }),
  );
}

// What each moment of an effect draws at `depth`, the effect held across them
// as a session holds it, as each moment's segments and rich-js's bytes.
const LOOPS = Object.keys(EFFECT_CATALOGUE.loops) as LoopName[];
const TIMES = [0, 0.75, 1.5, 3, 5, 8, 13, 21, 34, 55];
function underMotion(loop: LoopName, depth: ColorCompatibility) {
  const destination = resolveDestination(depth);
  const effect = EFFECT_CATALOGUE.loops[loop]({ z: 0 });
  return TIMES.map((time) => {
    const strip = new FlexStrip(cells(), { joiner: JOINERS.prism });
    const row = new Effected(strip, effect, {
      key: "row",
      theme: DEFAULT_TERMINAL_THEME,
    });
    const segments = drawn(row, destination, time, WIDTH);
    return { segments, ansi: segmentsToString(segments, destination) };
  });
}

const colorsOf = (lines: readonly (readonly Run[])[]): readonly string[] =>
  lines.flat().flatMap(({ fg, bg }) => [fg, bg].flatMap((c) => c ?? []));

// [LAW:single-enforcer] What a run says of its look at a depth, whatever drew it.
function expectDrawnAt(
  lines: readonly (readonly Run[])[],
  depth: ColorCompatibility,
): void {
  const colors = colorsOf(lines);
  if (depth === "none") {
    expect(lines.flat().filter((r) => r.fg || r.bg || r.attrs)).toEqual([]);
    return;
  }
  expect(colors).not.toEqual([]);
  if (depth === "256") {
    expect(colors.filter((c) => c.startsWith("#"))).toEqual([]);
  }
  if (depth === "ansi") {
    const standard = (c: string): boolean => {
      const { isDefault, number } = parse(c);
      return isDefault || (number !== undefined && number < 16);
    };
    expect(colors.filter((c) => !standard(c))).toEqual([]);
  }
}

describe("encodeAnsi over runLines writes what rich-js's encoder writes", () => {
  describe.each(DEPTHS)("at %s", (depth) => {
    const destination = resolveDestination(depth);

    test("a grid of every kind of colour, attribute and link", () => {
      const segments = grid();
      const ansi = segmentsToString(segments, destination);
      expect(ansi.endsWith("\n")).toBe(true);
      const lines = runLines(segments, destination);
      expect(encodeAnsi(lines, depth)).toBe(ansi.slice(0, -1));
      expectDrawnAt(lines, depth);
      expect(
        lines.flat().filter((run) => run.link !== undefined),
      ).not.toEqual([]);
    });

    test.each(LOOPS)("every moment of %s over a wrapped strip", (loop) => {
      for (const { segments, ansi } of underMotion(loop, depth)) {
        expect(ansi.endsWith("\n")).toBe(true);
        const lines = runLines(segments, destination);
        expect(encodeAnsi(lines, depth)).toBe(ansi.slice(0, -1));
        expectDrawnAt(lines, depth);
      }
    });
  });
});

describe("the reach of those comparisons", () => {
  test("the grid holds ColorBlends", () => {
    expect(blends(grid())).not.toEqual([]);
  });

  test("a strip under motion draws ColorBlends", () => {
    const frames = underMotion("wheel", "truecolor");
    expect(frames.flatMap(({ segments }) => blends(segments))).not.toEqual([]);
  });

  test.each(LOOPS)("the frames of %s differ across times", (loop) => {
    const ansis = underMotion(loop, "truecolor").map(({ ansi }) => ansi);
    expect(new Set(ansis).size).toBeGreaterThan(1);
  });

  test("a wrapped strip is several lines", () => {
    const destination = resolveDestination("truecolor");
    for (const { segments } of underMotion("wheel", "truecolor")) {
      expect(runLines(segments, destination).length).toBeGreaterThan(1);
    }
  });
});

describe("a run", () => {
  const truecolor = resolveDestination("truecolor");

  test("holds a flattened translucent colour as the hex it draws", () => {
    const ink = new Segment("x", new Style({ color: "#ffffff80" }));
    expect(runLines([ink], truecolor)).toEqual([
      [{ text: "x", fg: "#808080" }],
    ]);
  });

  test("holds a blend as the RGB of its mix", () => {
    const mix = ColorSpec.blend(parse("red"), parse("blue"), 0.5);
    const [[run]] = runLines(
      [new Segment("x", new Style({ bgcolor: mix }))],
      truecolor,
    ) as [[Run]];
    expect(run.bg).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("holds a standard colour by its name at truecolor", () => {
    const named = new Segment("x", new Style({ color: "red" }));
    expect(runLines([named], truecolor)).toEqual([[{ text: "x", fg: "red" }]]);
  });

  test("holds only the attributes that are on", () => {
    const style = new Style({ bold: false, italic: true, underline: true });
    expect(runLines([new Segment("x", style)], truecolor)).toEqual([
      [{ text: "x", attrs: ["italic", "underline"] }],
    ]);
  });

  test("keeps its link and no look at depth none", () => {
    const style = new Style({ color: "red", bold: true, link: LINK });
    const none = resolveDestination("none");
    expect(runLines([new Segment("x", style)], none)).toEqual([
      [{ text: "x", link: LINK }],
    ]);
  });
});

describe("a row of no cells", () => {
  test.each(DEPTHS)("is one line of no runs at %s", (colorCompatibility) => {
    const { lines } = drawStripCells([], {
      endcaps: "powerline",
      colorCompatibility,
      wrap: true,
      padding: 0,
      width: 80,
    });
    expect(lines).toEqual([[]]);
    const stacked = [[{ text: "a" }], ...lines, [{ text: "b" }]];
    expect(encodeAnsi(stacked, colorCompatibility)).toBe("a\n\nb");
  });
});

test("plainOf is a line's text", () => {
  expect(plainOf([{ text: "a", fg: "red" }, { text: "" }, { text: "b" }])).toBe(
    "ab",
  );
});

describe("the one path from a draw to bytes", () => {
  const SRC = path.join(__dirname, "..", "src");
  const FRAME = path.join("render", "frame.ts");
  const files = (fs.readdirSync(SRC, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({
      file,
      text: fs.readFileSync(path.join(SRC, file), "utf8"),
    }));
  // Every clause bringing a name in from rich-js. A namespace import brings in
  // every name it has.
  const FROM_RICH_JS = /\b(?:import|export)\b[^;]*?from\s+"@promptctl\/rich-js"/g;
  const importersOf = (name: string): readonly string[] =>
    files
      .filter(({ text }) =>
        (text.match(FROM_RICH_JS) ?? []).some((clause) =>
          new RegExp(`\\b${name}\\b|\\* as `).test(clause),
        ),
      )
      .map(({ file }) => file);

  test("the search can see an import", () => {
    expect(importersOf("segmentsToString")).toContain(FRAME);
  });

  test.each(["segmentsToString", "segmentToString", "renderToString", "Console"])(
    "only src/render/frame.ts imports %s",
    (name) => {
      expect(importersOf(name).filter((file) => file !== FRAME)).toEqual([]);
    },
  );

  test("nothing in src asks a style for its SGR codes", () => {
    const callers = files.filter(({ text }) => text.includes(".toSgrCodes("));
    expect(callers.map(({ file }) => file)).toEqual([]);
  });
});
