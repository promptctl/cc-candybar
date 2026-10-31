// [LAW:verifiable-goals] brandon-effects-2gka.d2i: the whole bar wears a looping
// effect chosen by `globals.effect`. An effect changes colours and nothing else,
// starts calm when it comes into force, and `none` draws exactly what the bar
// always drew.

import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { selectionFor } from "./helpers/selection";
import {
  ColorSpec,
  DEFAULT_TERMINAL_THEME,
  EFFECT_CATALOGUE,
  RichText,
  ColorDepth,
  Segment,
  decodeAnsi,
  render as drawSegments,
} from "@promptctl/rich-js";

import { SessionState } from "../src/daemon/session-state";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { EffectSessions, SessionEffects } from "../src/render/effect";
import type { RenderedLine } from "../src/dsl/node-registry";
import {
  decideEffectName,
  EFFECT_NAMES,
  type ColorCompatibility,
  type EffectName,
} from "../src/themes";
import type { Instant } from "../src/utils/instant";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { linkUrls, stripAnsi } from "./helpers/ansi";
import { resolvedStyle } from "../src/render/rich-theme";

// A frame that fades nothing in: what the effects under test here draw alone.
const STILL_FRAME = {
  transitions: false,
  source: { config: {}, preset: "default", revision: 0, width: 80 },
  last: null,
  returned: () => ({ drawing: null, deeper: [] }),
  hold: (line: RenderedLine) => line,
};

const LOOPS = Object.keys(EFFECT_CATALOGUE.loops) as EffectName[];
const START = 1_800_000_000 as Instant;
const at = (seconds: number): Instant => (START + seconds) as Instant;

// The bundled bar, so every row, seam and link a real bar draws is under the
// effect — the settings door's links included.
const BAR = parseAndValidate("<test>", "{}", undefined, DEFAULT_DSL_CONFIG);

// The bundled bar with a rule choosing the effect, and a row saying which
// effect the render settled on.
const RULED = parseAndValidate(
  "<test>",
  `{
    segments: { fx: { template: 'fx={{ .effect.effective }}' } },
    root: { rows: { fx: { h: ["fx"] } } },
    globals: {
      effect: '{{ if .activity.tool.running }}shimmer{{ else }}none{{ end }}',
    },
  }`,
  undefined,
  DEFAULT_DSL_CONFIG,
);

const RUNNING = { activity: { tool: { running: "Bash:1" } } };

function renderer(
  config: ValidatedConfig,
  colorCompatibility: ColorCompatibility = "truecolor",
): {
  readonly render: (
    effect: EffectName | undefined,
    when: Instant,
    effects?: SessionEffects<RenderedLine>,
    payload?: object,
  ) => string;
  readonly dispose: () => void;
} {
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
  const opts = {
    endcaps: "powerline" as const,
    colorCompatibility,
    wrap: true,
    padding: 1,
    width: 160,
  };
  return {
    render: (effect, when, effects, payload = {}) =>
      renderDsl(config, compiled, store, registry, payload, when, opts, undefined,
        selectionFor(config, {
          ...(effect === undefined ? {} : { effect: decideEffectName(effect) }),
          ...(effects === undefined ? {} : { effects }),
        }),
      ),
    dispose: () => registry.dispose(),
  };
}

describe("globals.effect: the whole bar wears a looping effect", () => {
  test("the domain is none and every catalogue loop, by rich-js's own names", () => {
    expect(EFFECT_NAMES).toEqual(["none", ...LOOPS]);
  });

  test("the assumed terminal is the one rich-js resolves for an unnamed terminal", () => {
    // [LAW:one-source-of-truth] rich-js does not export its assumed terminal, only
    // DEFAULT_TERMINAL_THEME; hold the two to the same colours.
    const unnamed = (fg: boolean): string =>
      ColorSpec.parse("default").getTruecolor(undefined, fg).hex;
    expect(DEFAULT_TERMINAL_THEME.backgroundColor.hex).toBe(unnamed(false));
    expect(DEFAULT_TERMINAL_THEME.foregroundColor.hex).toBe(unnamed(true));
    for (let i = 0; i < 16; i++) {
      expect(DEFAULT_TERMINAL_THEME.ansiColors.get(i).hex).toBe(
        ColorSpec.parse(`color(${i})`).getTruecolor(undefined, true).hex,
      );
    }
  });

  test("none draws the bytes a render with no effect named draws", () => {
    const { render, dispose } = renderer(BAR);
    try {
      expect(render("none", at(30), new SessionEffects<RenderedLine>("s"))).toBe(
        render(undefined, at(30)),
      );
    } finally {
      dispose();
    }
  });

  test.each(LOOPS)(
    "%s changes colours only: text and links match none at every instant, and it moves",
    (loop) => {
      const { render, dispose } = renderer(BAR);
      try {
        const effects = new SessionEffects<RenderedLine>("s");
        const instants = [0, 7, 30, 61, 200, 450];
        // Brought into force at the first instant, so t counts from there.
        const drawn = instants.map((s) => render(loop, at(s), effects));
        const still = instants.map((s) => render("none", at(s)));
        drawn.forEach((bytes, i) => {
          expect(stripAnsi(bytes)).toBe(stripAnsi(still[i]!));
          expect(linkUrls(bytes)).toEqual(linkUrls(still[i]!));
        });
        // [LAW:verifiable-goals] Otherwise the equalities above prove nothing.
        expect(drawn.some((bytes, i) => bytes !== still[i])).toBe(true);
      } finally {
        dispose();
      }
    },
  );

  test("pulse starts at rest: its first frame is none's bytes", () => {
    const { render, dispose } = renderer(BAR);
    try {
      expect(render("pulse", at(5), new SessionEffects<RenderedLine>("s"))).toBe(
        render("none", at(5)),
      );
    } finally {
      dispose();
    }
  });

  test("an effect's clock starts when it comes into force, not at the first render", () => {
    const { render, dispose } = renderer(BAR);
    try {
      const late = new SessionEffects<RenderedLine>("s");
      render("none", at(0), late);
      // Pulse came into force at 300: its first frame is at rest.
      expect(render("pulse", at(300), late)).toBe(render("none", at(300)));
      // On a session where pulse has been on since 0, the same stretch moves.
      const early = new SessionEffects<RenderedLine>("s");
      render("pulse", at(0), early);
      const moved = [100, 200, 300].some(
        (s) => render("pulse", at(s), early) !== render("none", at(s)),
      );
      expect(moved).toBe(true);
    } finally {
      dispose();
    }
  });

  test.each(LOOPS)("under colorCompatibility none, %s draws none's bytes", (loop) => {
    const { render, dispose } = renderer(BAR, "none");
    try {
      const effects = new SessionEffects<RenderedLine>("s");
      for (const s of [0, 30, 200]) {
        expect(render(loop, at(s), effects)).toBe(render("none", at(s)));
      }
    } finally {
      dispose();
    }
  });

  test("a rule flips the effect as the payload changes", () => {
    const { render, dispose } = renderer(RULED);
    try {
      const effects = new SessionEffects<RenderedLine>("s");
      const quiet = render(undefined, at(0), effects);
      expect(stripAnsi(quiet)).toContain("fx=none");
      // A tool starts: the rule names shimmer, whose clock starts now. Every
      // frame reads the same words, so a frame differing from the first is the
      // shimmer moving.
      const frames = [0, 30, 60, 90, 120].map((s) =>
        render(undefined, at(10 + s), effects, RUNNING),
      );
      for (const frame of frames) {
        expect(stripAnsi(frame)).toBe(stripAnsi(frames[0]!));
      }
      expect(stripAnsi(frames[0]!)).toContain("fx=shimmer");
      expect(frames.some((frame) => frame !== frames[0])).toBe(true);
      // The tool finishes: still again, byte for byte.
      const after = render(undefined, at(200), effects);
      expect(stripAnsi(after)).toContain("fx=none");
      expect(after).toBe(render("none", at(200)));
    } finally {
      dispose();
    }
  });

  test("a session holds the effects of the rows its latest render drew, and no others", () => {
    const sessions = new EffectSessions<RenderedLine>();
    const effects = sessions.of("s");
    const draw = (when: Instant, rows: number): void => {
      const motion = effects.motion("shimmer", effects.clockAt(when, 1), STILL_FRAME);
      for (let row = 0; row < rows; row++) {
        const moving = motion.row(`flow.own#${row}`, "bar", []);
        if (moving.kind !== "moving") throw new Error("shimmer is still");
        moving.wrap(new RichText("x"));
      }
      motion.drawn();
    };
    // A menu opens: five rows. It closes: one row, whose effect is reused.
    draw(at(0), 5);
    expect(sessions.getStats()).toEqual({ sessions: 1, effects: 5 });
    draw(at(1), 1);
    expect(sessions.getStats()).toEqual({ sessions: 1, effects: 1 });
    expect(effects.lastFrame()).toMatchObject({ made: 0, reused: 1 });
    // The menu opens again: the rows it released are made afresh.
    draw(at(2), 5);
    expect(effects.lastFrame()).toMatchObject({ made: 4, reused: 1 });
  });

  test("a row says when it next changes: now while its loop moves, never while every part holds still", () => {
    const effects = new SessionEffects<RenderedLine>("s");
    const motion = effects.motion("shimmer", effects.clockAt(at(7), 1), STILL_FRAME);
    const moving = motion.row("flow.own#0", "bar", []);
    if (moving.kind !== "moving") throw new Error("shimmer is still");
    const row = moving.wrap(new RichText("abc"));
    const nextChange = (colorSystem: ColorDepth): number =>
      Segment.nextChange(drawSegments(row, { maxWidth: 80, colorSystem }));
    // The bar's clock starts at 7, so the row is drawn at its own t = 0.
    expect(nextChange(ColorDepth.TRUECOLOR)).toBe(0);
    // At ansi the loop holds every cell still, and the row says so rather than
    // asking to be drawn again every frame.
    expect(nextChange(ColorDepth.STANDARD)).toBe(Number.POSITIVE_INFINITY);
  });

  test("a row keeps its motion when lines of another kind appear above it", () => {
    // One bar, its group's body closed and open: the open body's lines push the
    // bottom row lower, but it is the same row of the bar, so it moves alike.
    const grouped = (open: boolean): ValidatedConfig =>
      parseAndValidate(
        "<test>",
        `{
          segments: {
            inner: { template: 'inside the group' },
            bottom: { template: 'bottom row, the same in both renders' },
          },
          root: { v: [
            { kind: "group", name: "g", label: "g", open: ${open}, children: [{ v: ["inner", { seg: "inner", id: "inner-2" }] }] },
            "bottom",
          ] },
        }`,
        undefined,
        DEFAULT_DSL_CONFIG,
      );
    const closed = renderer(grouped(false));
    const opened = renderer(grouped(true));
    try {
      const bottom = (bytes: string): string =>
        bytes.split("\n").find((line) => stripAnsi(line).includes("bottom row"))!;
      for (const loop of LOOPS) {
        const effects = new SessionEffects<RenderedLine>("s");
        closed.render(loop, at(0), effects);
        const before = closed.render(loop, at(30), effects);
        const after = opened.render(loop, at(30), effects);
        // [LAW:verifiable-goals] The body really added lines above the row.
        expect(after.split("\n").length).toBeGreaterThan(before.split("\n").length);
        expect(bottom(after)).toBe(bottom(before));
      }
    } finally {
      closed.dispose();
      opened.dispose();
    }
  });
});

// [LAW:verifiable-goals] brandon-menus-sjhy.ju8: a segment's turn depends on
// where it sits. Near neighbours pace nearly alike, so the three here stand
// far apart, a different fill between them.
describe("the wheel paces each segment by where it sits", () => {
  const SEGMENTS = ["AAAA", "BBBB", "CCCC"];
  const WHEELED = parseAndValidate(
    "<test>",
    `{
      segments: {
        a: { template: 'AAAA', bg: '#336699' },
        gap1: { template: '${"-".repeat(30)}', bg: '#996633' },
        b: { template: 'BBBB', bg: '#336699' },
        gap2: { template: '${"-".repeat(30)}', bg: '#996633' },
        c: { template: 'CCCC', bg: '#336699' },
      },
      root: { rows: { wheeled: { h: ["a", "gap1", "b", "gap2", "c"] } } },
    }`,
    undefined,
    DEFAULT_DSL_CONFIG,
  );

  const fillOf = (rendered: string, word: string): string => {
    const line = rendered.split("\n").find((l) => stripAnsi(l).includes(word));
    if (line === undefined) throw new Error(`no line draws ${word}`);
    const text = decodeAnsi(line);
    const at = text.plain.indexOf(word);
    const span = text.spans.find(({ start, end }) => start <= at && at < end);
    const bgcolor = span === undefined ? undefined : resolvedStyle(span.style).bgcolor;
    if (bgcolor === undefined) throw new Error(`${word} is drawn without its own ground`);
    return bgcolor.getTruecolor().hex;
  };

  test("segments of one fill at different places turn to different colours, from the frame they all began in", () => {
    const { render, dispose } = renderer(WHEELED);
    try {
      const effects = new SessionEffects<RenderedLine>("s");
      const first = render("wheel", at(5), effects);
      expect(first).toBe(render("none", at(5)));
      expect(new Set(SEGMENTS.map((word) => fillOf(first, word))).size).toBe(1);
      const later = render("wheel", at(65), effects);
      expect(new Set(SEGMENTS.map((word) => fillOf(later, word))).size).toBe(SEGMENTS.length);
    } finally {
      dispose();
    }
  });
});
