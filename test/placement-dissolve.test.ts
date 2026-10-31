// [LAW:verifiable-goals] brandon-effects-2gka.3vt: a placement dissolves out
// when it leaves. One that stops being drawn between two frames drawn from the
// same config, preset and session state thins away over 30 s instead of
// vanishing: the bar replays what it last drew — its own rows, nothing to
// click — under rich-js's dissolve, never evaluating it again, keeps its width
// until the dissolve is over, then closes up in one step. A write to the
// session's state, the width or the palette ends every dissolve in flight.

import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { selectionFor } from "./helpers/selection";
import { decodeAnsi } from "@promptctl/rich-js";

import { SessionState } from "../src/daemon/session-state";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { ValidatedConfig } from "../src/config/dsl-types";
import type { RenderedLine } from "../src/dsl/node-registry";
import { SessionEffects } from "../src/render/effect";
import { resolvedStyle } from "../src/render/rich-theme";
import { decideEffectName, type EffectName } from "../src/themes";
import type { Instant } from "../src/utils/instant";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { linkUrls, stripAnsi } from "./helpers/ansi";

const START = 1_800_000_000 as Instant;
const at = (seconds: number): Instant => (START + seconds) as Instant;
// The instant the middle placement stops being drawn.
const S = 30;
const LINK = "https://example.com/middle";

// The middle placement links somewhere, and its template fails on the payload
// that hides it, as a cell gated on a running tool fails once the tool's
// fields are gone. `gated` is where the gate sits: on the segment's own
// `when`, or on a container around it.
const MIDDLE_TEMPLATE = `'{{ if not .shown }}{{ fail "the tool is gone" }}{{ end }}{{ link "${LINK}" "MIDDLE" }}'`;
const config = (gated: "segment" | "container"): ValidatedConfig =>
  parseAndValidate(
    "<test>",
    `{
      variables: {
        shown: { kind: "input", path: "shown", type: "boolean", default: false },
      },
      segments: {
        left: { template: 'left cell' },
        middle: {
          template: ${MIDDLE_TEMPLATE},
          ${gated === "segment" ? `when: '{{ .shown }}',` : ""}
        },
        right: { template: 'right cell' },
        extra: { template: 'EXTRA' },
      },
      root: { v: [
        { h: ["left", ${gated === "segment" ? '"middle"' : `{ h: ["middle"], when: '{{ .shown }}' }`}, "right"] },
        { kind: "group", name: "more", label: "more", children: ["extra"] },
      ] },
    }`,
    undefined,
    DEFAULT_DSL_CONFIG,
  );

interface Frame {
  readonly shown: boolean;
  readonly when: Instant;
  readonly width?: number;
  readonly dark?: boolean;
}

// A renderer over one load of `cfg`, as a render cache entry's frames are
// drawn until it reloads.
function renderer(cfg: ValidatedConfig, session = new SessionState()) {
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", session);
  const compiled = registerDslConfig(cfg, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
  const opts = {
    endcaps: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    wrap: true,
    padding: 1,
    width: 160,
  };
  return {
    session,
    render: (
      { shown, when, width = 160, dark = false }: Frame,
      effects: SessionEffects<RenderedLine>,
      transitions: boolean,
      bar: EffectName = "none",
    ): string =>
      renderDsl(
        cfg,
        compiled,
        store,
        registry,
        { session_id: "s", shown, dark },
        when,
        { ...opts, width },
        undefined,
        selectionFor(cfg, { effect: decideEffectName(bar), effects, transitions }),
      ),
    dispose: () => registry.dispose(),
  };
}

const firstRow = (out: string): string => out.split("\n")[0]!;

// Each screen cell of a line: its glyph and the colours it is drawn in, read
// through rich-js's own decoder (the inverse of the writer).
function screenCells(line: string): string[] {
  const text = decodeAnsi(line);
  const colours = [...text.plain].map(() => "");
  for (const { start, end, style } of text.spans) {
    const { color, bgcolor } = resolvedStyle(style);
    for (let i = start; i < end; i++)
      colours[i] = `${color?.name ?? "-"}/${bgcolor?.name ?? "-"}`;
  }
  return [...text.plain].map((glyph, i) => `${glyph}${colours[i]}`);
}

// The columns the middle placement's colours show in: its cell (the text and
// the padding each side of it) and the seam either side of it.
function middleColumns(line: string): { from: number; to: number } {
  const col = stripAnsi(line).indexOf("MIDDLE");
  return { from: col - 2, to: col + "MIDDLE".length + 2 };
}

describe.each(["segment", "container"] as const)(
  "a placement whose %s gate turns false dissolves out",
  (gated) => {
    const ROW = config(gated);
    const before = { shown: true, when: at(S - 10) };
    const leaving = (since: number): Frame => ({
      shown: false,
      when: at(S + since),
    });

    test.each(["none", "shimmer"] as const)(
      "under a bar wearing %s: kept at once, part-thinned at +15 at its width, byte-identical to no transitions at +30",
      (bar) => {
        const on = renderer(ROW);
        const off = renderer(ROW);
        try {
          const onFx = new SessionEffects<RenderedLine>("s");
          const offFx = new SessionEffects<RenderedLine>("s");
          const both = (frame: Frame) => ({
            on: on.render(frame, onFx, true, bar),
            off: off.render(frame, offFx, false, bar),
          });
          both({ shown: true, when: at(0) });
          const drawn = both(before).on;
          expect(stripAnsi(drawn)).toContain("MIDDLE");

          // It leaves: its text stays where it was, and so does every other.
          const left = both(leaving(0));
          expect(stripAnsi(firstRow(left.off))).not.toContain("MIDDLE");
          expect(stripAnsi(firstRow(left.on))).toBe(
            stripAnsi(firstRow(drawn)),
          );

          // Mid-dissolve: its cells thin and nothing else moves; the row
          // keeps its width.
          const mid = both(leaving(15));
          expect(stripAnsi(firstRow(mid.on))).toBe(stripAnsi(firstRow(drawn)));
          const thinned = screenCells(firstRow(mid.on));
          const whole = screenCells(firstRow(left.on));
          const { from, to } = middleColumns(firstRow(drawn));
          expect(thinned.slice(from, to)).not.toEqual(whole.slice(from, to));
          if (bar === "none") {
            expect(thinned.slice(0, from)).toEqual(whole.slice(0, from));
            expect(thinned.slice(to)).toEqual(whole.slice(to));
          }
          expect(mid.on.split("\n").slice(1)).toEqual(
            mid.off.split("\n").slice(1),
          );

          // Just short of the end it still holds the row's width.
          expect(stripAnsi(firstRow(both(leaving(29)).on))).toBe(
            stripAnsi(firstRow(drawn)),
          );
          // Over: the row closes up in one step, as if it had never been
          // drawn under a transition.
          const done = both(leaving(30));
          expect(done.on).toBe(done.off);
          const after = both(leaving(35));
          expect(after.on).toBe(after.off);
        } finally {
          on.dispose();
          off.dispose();
        }
      },
    );

    test("it offers nothing to click while it leaves, and is never evaluated again", () => {
      const on = renderer(ROW);
      try {
        const fx = new SessionEffects<RenderedLine>("s");
        on.render({ shown: true, when: at(0) }, fx, true);
        expect(linkUrls(on.render(before, fx, true))).toContain(LINK);
        for (const since of [0, 1, 15, 29]) {
          const out = on.render(leaving(since), fx, true);
          expect(stripAnsi(out)).toContain("MIDDLE");
          expect(linkUrls(out)).not.toContain(LINK);
          // Its template fails on this payload: drawn again, it would be a ⚠.
          expect(stripAnsi(out)).not.toContain("⚠");
        }
      } finally {
        on.dispose();
      }
    });

    test("its event names it leaving on its dissolve's clock", () => {
      const on = renderer(ROW);
      try {
        const fx = new SessionEffects<RenderedLine>("s");
        on.render({ shown: true, when: at(0) }, fx, true);
        on.render(before, fx, true);
        expect(fx.lastFrame()).toMatchObject({ fades: [], leaves: [] });
        on.render(leaving(0), fx, true);
        expect(fx.lastFrame()).toMatchObject({
          basis: "compared",
          fades: [],
          leaves: [{ placement: "middle", t: 0 }],
        });
        on.render(leaving(15), fx, true);
        expect(fx.lastFrame().leaves).toEqual([{ placement: "middle", t: 15 }]);
        on.render(leaving(30), fx, true);
        expect(fx.lastFrame().leaves).toEqual([]);
      } finally {
        on.dispose();
      }
    });

    test("drawn again before its dissolve is over, it stops leaving and fades in", () => {
      const on = renderer(ROW);
      try {
        const fx = new SessionEffects<RenderedLine>("s");
        on.render({ shown: true, when: at(0) }, fx, true);
        on.render(before, fx, true);
        on.render(leaving(0), fx, true);
        on.render(leaving(10), fx, true);
        const back = on.render({ shown: true, when: at(S + 11) }, fx, true);
        expect(fx.lastFrame()).toMatchObject({
          fades: [{ placement: "middle", t: 0 }],
          leaves: [],
        });
        // Drawn again: its link is back.
        expect(linkUrls(back)).toContain(LINK);
      } finally {
        on.dispose();
      }
    });
  },
);

describe("a trigger replays its own row only while nothing hangs open under it", () => {
  const cfg = parseAndValidate(
    "<test>",
    `{
      variables: {
        shown: { kind: "input", path: "shown", type: "boolean", default: false },
      },
      segments: { left: { template: 'left cell' }, extra: { template: 'EXTRA' } },
      root: { v: [
        { h: ["left", { kind: "group", name: "more", label: "MORE", when: '{{ .shown }}', children: ["extra"] }] },
      ] },
    }`,
    undefined,
    DEFAULT_DSL_CONFIG,
  );
  // Its toggle hidden by data, with the group open or closed since before the
  // frames compared, so none of them is fresh.
  const hiddenWith = (open: boolean) => {
    const on = renderer(cfg);
    const off = renderer(cfg, on.session);
    try {
      if (open) on.session.set("s", "groups.more", "more");
      const fx = new SessionEffects<RenderedLine>("s");
      on.render({ shown: true, when: at(0) }, fx, true);
      const drawn = stripAnsi(on.render({ shown: true, when: at(1) }, fx, true));
      expect(drawn).toContain("MORE");
      expect(drawn.includes("EXTRA")).toBe(open);
      const frame = { shown: false, when: at(S) };
      return {
        fx,
        on: on.render(frame, fx, true),
        off: off.render(frame, new SessionEffects<RenderedLine>("s"), false),
      };
    } finally {
      on.dispose();
      off.dispose();
    }
  };

  test("open: it goes at once, with its body, rather than replaying an open trigger over nothing", () => {
    const { fx, on, off } = hiddenWith(true);
    expect(fx.lastFrame().leaves).toEqual([]);
    expect(on).toBe(off);
  });

  test("closed: it dissolves, holding its row", () => {
    const { fx, on } = hiddenWith(false);
    expect(fx.lastFrame().leaves).toEqual([{ placement: "groups.more", t: 0 }]);
    expect(stripAnsi(on)).toContain("MORE");
  });
});

describe("a write to the session's state ends every dissolve in flight", () => {
  const ROW = config("segment");
  const midDissolve = (
    write: (session: SessionState) => void,
  ): { on: string; off: string } => {
    const on = renderer(ROW);
    const off = renderer(ROW, on.session);
    try {
      const fx = new SessionEffects<RenderedLine>("s");
      on.render({ shown: true, when: at(0) }, fx, true);
      on.render({ shown: false, when: at(S) }, fx, true);
      on.render({ shown: false, when: at(S + 10) }, fx, true);
      expect(fx.lastFrame().leaves).toEqual([{ placement: "middle", t: 10 }]);
      write(on.session);
      const frame = { shown: false, when: at(S + 11) };
      const result = {
        on: on.render(frame, fx, true),
        off: off.render(frame, new SessionEffects<RenderedLine>("s"), false),
      };
      expect(fx.lastFrame()).toMatchObject({ basis: "fresh", leaves: [] });
      return result;
    } finally {
      on.dispose();
      off.dispose();
    }
  };

  test("a click: the next frame is byte-identical to no transitions", () => {
    const { on, off } = midDissolve((session) =>
      session.set("s", "groups.more", "more"),
    );
    expect(stripAnsi(on)).toContain("EXTRA");
    expect(stripAnsi(on)).not.toContain("MIDDLE");
    expect(on).toBe(off);
  });

  test("✎ arrange: the first frame after it is byte-identical to no transitions", () => {
    const { on, off } = midDissolve((session) =>
      session.set("s", "edit.mode", "arrange"),
    );
    expect(on).toBe(off);
  });
});

// [LAW:no-ambient-temporal-coupling] A held row was sized for the width of the
// frame it was drawn in, so a frame drawn at another width compares against
// nothing. A palette is not part of that: a rule-chosen theme or style moves
// on the very payload that hides a placement, and the held row dissolves in
// the colours it was drawn in.
describe("another width ends every dissolve in flight; another palette does not", () => {
  const ROW = parseAndValidate(
    "<test>",
    `{
      globals: { palette: '{{ if .dark }}nord{{ else }}dracula{{ end }}' },
      variables: {
        shown: { kind: "input", path: "shown", type: "boolean", default: false },
        dark: { kind: "input", path: "dark", type: "boolean", default: false },
      },
      segments: {
        left: { template: 'left cell' },
        middle: { template: 'MIDDLE', when: '{{ .shown }}' },
        right: { template: 'right cell' },
      },
      root: { v: [{ h: ["left", "middle", "right"] }] },
    }`,
    undefined,
    DEFAULT_DSL_CONFIG,
  );

  const leaveThen = (change: Partial<Frame>) => {
    const on = renderer(ROW);
    const off = renderer(ROW);
    try {
      const fx = new SessionEffects<RenderedLine>("s");
      on.render({ shown: true, when: at(0) }, fx, true);
      on.render({ shown: false, when: at(S) }, fx, true);
      expect(fx.lastFrame().leaves).toEqual([{ placement: "middle", t: 0 }]);
      const frame = { shown: false, when: at(S + 1), ...change };
      return {
        fx,
        on: on.render(frame, fx, true),
        off: off.render(frame, new SessionEffects<RenderedLine>("s"), false),
      };
    } finally {
      on.dispose();
      off.dispose();
    }
  };

  test("another width: the next frame is byte-identical to no transitions", () => {
    const { fx, on, off } = leaveThen({ width: 120 });
    expect(fx.lastFrame()).toMatchObject({ basis: "fresh", leaves: [] });
    expect(stripAnsi(on)).not.toContain("MIDDLE");
    expect(on).toBe(off);
  });

  test("a rule moving the theme on the same payload: it keeps dissolving", () => {
    const { fx, on } = leaveThen({ dark: true });
    expect(fx.lastFrame()).toMatchObject({
      basis: "compared",
      leaves: [{ placement: "middle", t: 1 }],
    });
    expect(stripAnsi(on)).toContain("MIDDLE");
  });
});

