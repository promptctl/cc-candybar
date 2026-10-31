// [LAW:verifiable-goals] brandon-effects-2gka.631: a placement fades in when it
// appears. One whose `when` turns true between two frames drawn from the same
// config, preset and session state fades in over 20 s, its cells alone, from
// its own palette's ground; a first render, a write to the session's state —
// a click, an undo — and a reload draw from another source, so nothing they
// reveal fades.

import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { selectionFor } from "./helpers/selection";
import {
  DEFAULT_TERMINAL_THEME,
  RichText,
  decodeAnsi,
  resolveColorRef,
} from "@promptctl/rich-js";

import { SessionState } from "../src/daemon/session-state";
import { SettingsHistory } from "../src/daemon/settings-history";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import {
  compileDslConfig,
  compileInputOf,
  compileKey,
  declareDslVariables,
  EVERY_SCOPE,
  renderDsl,
  type CompiledConfig,
} from "../src/dsl/render";
import { lastBinding } from "./helpers/render-binding";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { SessionEffects, type RowItem } from "../src/render/effect";
import { FrameMemory } from "../src/render/frame-memory";
import { framed } from "./helpers/frames";
import type { RenderedLine } from "../src/dsl/node-registry";
import { resolvedStyle } from "../src/render/rich-theme";
import {
  decideEffectName,
  paletteForThemeName,
  type EffectName,
} from "../src/themes";
import type { Instant } from "../src/utils/instant";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { stripAnsi } from "./helpers/ansi";

const START = 1_800_000_000 as Instant;
const at = (seconds: number): Instant => (START + seconds) as Instant;
// The instant the middle placement's `when` turns true.
const S = 30;

// A row whose middle placement shows while the payload says so, placed as
// `middle` spells it, and a group whose body a click opens.
const config = (globals = "{}", middle = '"middle"'): ValidatedConfig =>
  parseAndValidate(
    "<test>",
    `{
      globals: ${globals},
      variables: {
        shown: { kind: "input", path: "shown", type: "boolean", default: false },
      },
      segments: {
        left: { template: 'left cell' },
        middle: { template: 'MIDDLE', when: '{{ .shown }}' },
        right: { template: 'right cell' },
        extra: { template: 'EXTRA' },
      },
      root: { v: [
        { h: ["left", ${middle}, "right"] },
        { kind: "group", name: "more", label: "more", children: ["extra"] },
      ] },
    }`,
    undefined,
    DEFAULT_DSL_CONFIG,
  );
const ROW = config();

interface Frame {
  readonly shown: boolean;
  readonly when: Instant;
}

// A renderer over one load of `cfg`: every frame it draws is drawn from the
// same load of the config, as a render cache entry's are until it reloads —
// over its own compile, or one it shares with another load, as the cache
// shares one between entries whose configs compile alike.
function renderer(
  cfg: ValidatedConfig,
  session = new SessionState(),
  compiled: CompiledConfig = compileDslConfig(compileInputOf(cfg), TEST_SIGNER),
) {
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", session);
  declareDslVariables(cfg, registry, "/tmp", EVERY_SCOPE);
  const opts = {
    endcaps: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    wrap: true,
    padding: 1,
    width: 160,
  };
  const drawn = lastBinding(compiled.menuRuntime.action);
  return {
    session,
    // The palette the latest render wore.
    palette: () => drawn().look!.palette,
    render: (
      { shown, when }: Frame,
      effects: SessionEffects<RenderedLine>,
      selection: { transitions?: boolean; bar?: EffectName } = {},
    ): string =>
      renderDsl(
        cfg,
        compiled,
        store,
        registry,
        { session_id: "s", shown },
        when,
        opts,
        undefined,
        selectionFor(cfg, {
          effect: decideEffectName(selection.bar ?? "none"),
          effects,
          ...(selection.transitions !== undefined && {
            transitions: selection.transitions,
          }),
        }),
      ),
    dispose: () => registry.dispose(),
  };
}

// Each screen cell of a line: its glyph and the style it is drawn in, read
// through rich-js's own decoder (the inverse of the writer).
function screenCells(line: string): string[] {
  const text = decodeAnsi(line);
  const styles = [...text.plain].map(() => "");
  for (const { start, end, style } of text.spans) {
    const resolved = JSON.stringify(resolvedStyle(style));
    for (let i = start; i < end; i++) styles[i] = resolved;
  }
  return [...text.plain].map((glyph, i) => `${glyph}${styles[i]}`);
}

// The columns the middle placement's colours show in: its cell (the text and
// the padding each side of it) and the seam either side of it.
function middleColumns(line: string): { from: number; to: number } {
  const col = [...stripAnsi(line)].join("").indexOf("MIDDLE");
  return { from: col - 2, to: col + "MIDDLE".length + 2 };
}

// The frames of a session whose middle placement appears at S.
const FRAMES: readonly Frame[] = [0, 10, 20, S, S + 5, S + 10, S + 15, S + 19, S + 20, S + 25].map(
  (s) => ({ shown: s >= S, when: at(s) }),
);

describe("a placement that appears fades in", () => {
  test.each(["none", "shimmer"] as const)(
    "under a bar wearing %s: untouched before it appears, its cells alone part-faded at +10, byte-identical at +20",
    (bar) => {
      const on = renderer(ROW);
      const off = renderer(ROW);
      try {
        const onFx = new SessionEffects<RenderedLine>("s");
        const offFx = new SessionEffects<RenderedLine>("s");
        for (const frame of FRAMES) {
          const faded = on.render(frame, onFx, { transitions: true, bar });
          const plain = off.render(frame, offFx, { transitions: false, bar });
          const since = (frame.when - START) - S;
          // A fade changes colours, never text.
          expect(stripAnsi(faded)).toBe(stripAnsi(plain));
          if (since < 0 || since >= 20) {
            expect(faded).toBe(plain);
            continue;
          }
          // In flight: the middle placement's cells move and nothing else does.
          const row = (out: string) => out.split("\n")[0]!;
          const a = screenCells(row(faded));
          const b = screenCells(row(plain));
          const { from, to } = middleColumns(row(plain));
          expect(a.slice(0, from)).toEqual(b.slice(0, from));
          expect(a.slice(to)).toEqual(b.slice(to));
          // Each cell rises over 9 s of the 20, so a short placement can look
          // whole before its fade is done; through +10 it is still veiled.
          if (since <= 10)
            expect(a.slice(from, to)).not.toEqual(b.slice(from, to));
          expect(faded.split("\n").slice(1)).toEqual(plain.split("\n").slice(1));
        }
      } finally {
        on.dispose();
        off.dispose();
      }
    },
  );

  // Wholly veiled at its t = 0, the middle placement's ink and fill are both
  // the ground it rises from.
  const risesFrom = (cfg: ValidatedConfig): { row: string; bar: string } => {
    const on = renderer(cfg);
    try {
      const fx = new SessionEffects<RenderedLine>("s");
      on.render({ shown: false, when: at(0) }, fx, { transitions: true });
      const row = on
        .render({ shown: true, when: at(S) }, fx, { transitions: true })
        .split("\n")[0]!;
      const bar = resolveColorRef(on.palette(), "background").hex.toLowerCase();
      return { row, bar };
    } finally {
      on.dispose();
    }
  };
  const expectGround = (row: string, ground: string): void => {
    const text = decodeAnsi(row);
    const col = text.plain.indexOf("MIDDLE");
    for (let i = col; i < col + "MIDDLE".length; i++) {
      const style = resolvedStyle(
        text.spans.find(({ start, end }) => start <= i && i < end)!.style,
      );
      expect(style.bgcolor?.name.toLowerCase()).toBe(ground);
      expect(style.color?.name.toLowerCase()).toBe(ground);
    }
  };

  test("it rises from the theme's background, not the terminal the loops assume", () => {
    const { row, bar } = risesFrom(ROW);
    expectGround(row, bar);
    expect(bar).not.toBe("#000000");
  });

  test("a placement pinned to a theme rises from that theme's background", () => {
    const { row, bar } = risesFrom(
      config("{}", '{ seg: "middle", settings: { theme: "nord" } }'),
    );
    const nord = resolveColorRef(
      paletteForThemeName("nord"),
      "background",
    ).hex.toLowerCase();
    expect(nord).not.toBe(bar);
    expectGround(row, nord);
  });

  test("its event says what the frame compared against, and what is fading in on what clock", () => {
    const on = renderer(ROW);
    try {
      const fx = new SessionEffects<RenderedLine>("s");
      on.render({ shown: false, when: at(0) }, fx, { transitions: true });
      expect(fx.lastFrame()).toMatchObject({ basis: "fresh", fades: [] });
      on.render({ shown: true, when: at(S) }, fx, { transitions: true });
      expect(fx.lastFrame()).toMatchObject({
        basis: "compared",
        fades: [{ placement: "middle", t: 0 }],
      });
      on.render({ shown: true, when: at(S + 10) }, fx, { transitions: true });
      expect(fx.lastFrame().fades).toEqual([{ placement: "middle", t: 10 }]);
      on.render({ shown: true, when: at(S + 20) }, fx, { transitions: true });
      expect(fx.lastFrame()).toMatchObject({ basis: "compared", fades: [] });
      on.render({ shown: true, when: at(S + 21) }, fx, { transitions: false });
      expect(fx.lastFrame().basis).toBe("off");
      // A frame drawn with transitions off recorded nothing to compare against.
      on.render({ shown: true, when: at(S + 22) }, fx, { transitions: true });
      expect(fx.lastFrame()).toMatchObject({ basis: "fresh", fades: [] });
    } finally {
      on.dispose();
    }
  });

  test("a config's globals.transitions turns it on for a caller that resolves none", () => {
    const on = renderer(config("{ transitions: true }"));
    const off = renderer(ROW);
    try {
      const onFx = new SessionEffects<RenderedLine>("s");
      const offFx = new SessionEffects<RenderedLine>("s");
      on.render({ shown: false, when: at(0) }, onFx);
      off.render({ shown: false, when: at(0) }, offFx);
      const shown = { shown: true, when: at(S + 10) };
      expect(on.render(shown, onFx)).not.toBe(off.render(shown, offFx));
      expect(onFx.lastFrame().fades).toEqual([{ placement: "middle", t: 0 }]);
    } finally {
      on.dispose();
      off.dispose();
    }
  });
});

describe("nothing fades in where the frame is drawn from another source", () => {
  test("the first render draws every placement at once", () => {
    const on = renderer(ROW);
    const off = renderer(ROW);
    try {
      const frame = { shown: true, when: at(S) };
      expect(on.render(frame, new SessionEffects<RenderedLine>("s"), { transitions: true })).toBe(
        off.render(frame, new SessionEffects<RenderedLine>("s"), { transitions: false }),
      );
    } finally {
      on.dispose();
      off.dispose();
    }
  });

  test("a write to the session's state shows what it reveals at once, and ends a fade in flight", () => {
    const on = renderer(ROW);
    const off = renderer(ROW, on.session);
    try {
      const fx = new SessionEffects<RenderedLine>("s");
      on.render({ shown: false, when: at(0) }, fx, { transitions: true });
      on.render({ shown: true, when: at(S) }, fx, { transitions: true });
      expect(fx.lastFrame().fades).toEqual([{ placement: "middle", t: 0 }]);
      // Mid-fade, a click opens the group.
      on.session.set("s", "groups.more", "more");
      const frame = { shown: true, when: at(S + 5) };
      const opened = on.render(frame, fx, { transitions: true });
      expect(stripAnsi(opened)).toContain("EXTRA");
      expect(fx.lastFrame()).toMatchObject({
        basis: "fresh",
        revision: on.session.revision("s"),
        fades: [],
      });
      expect(opened).toBe(
        off.render(frame, new SessionEffects<RenderedLine>("s"), { transitions: false }),
      );
    } finally {
      on.dispose();
      off.dispose();
    }
  });

  test("an undo is a write like a click's: the frame after it compares against nothing", () => {
    const on = renderer(ROW);
    try {
      const history = new SettingsHistory(on.session, () => {});
      const journal = history.begin();
      journal.sessionState.set("s", "theme", "nord");
      journal.commit();
      const fx = new SessionEffects<RenderedLine>("s");
      on.render({ shown: false, when: at(0) }, fx, { transitions: true });
      on.render({ shown: false, when: at(1) }, fx, { transitions: true });
      expect(fx.lastFrame().basis).toBe("compared");
      history.undo("s");
      on.render({ shown: false, when: at(2) }, fx, { transitions: true });
      expect(fx.lastFrame().basis).toBe("fresh");
    } finally {
      on.dispose();
    }
  });

  // brandon-unfiled-3248.8yp: the render cache shares one compile between
  // loads that compile alike, so the identity a frame compares is the load's
  // config, not the compile.
  test("a reload over a shared compile still compares against nothing", () => {
    const loaded = config();
    const again = config();
    expect(compileKey(compileInputOf(again))).toBe(compileKey(compileInputOf(loaded)));
    const shared = compileDslConfig(compileInputOf(loaded), TEST_SIGNER);
    const first = renderer(loaded, new SessionState(), shared);
    const reloaded = renderer(again, new SessionState(), shared);
    try {
      const fx = new SessionEffects<RenderedLine>("s");
      first.render({ shown: false, when: at(0) }, fx, { transitions: true });
      reloaded.render({ shown: true, when: at(S) }, fx, { transitions: true });
      expect(fx.lastFrame()).toMatchObject({ basis: "fresh", fades: [] });
      // Drawn from the same load again, the frame compares.
      reloaded.render({ shown: true, when: at(S + 1) }, fx, { transitions: true });
      expect(fx.lastFrame().basis).toBe("compared");
    } finally {
      first.dispose();
      reloaded.dispose();
    }
  });

  test("a reload: a frame drawn from another load of the config compares against nothing", () => {
    const first = renderer(ROW);
    // Another load: the loader builds a new config object, as a reload does.
    const reloaded = renderer(config());
    try {
      const fx = new SessionEffects<RenderedLine>("s");
      first.render({ shown: false, when: at(0) }, fx, { transitions: true });
      reloaded.render({ shown: true, when: at(S) }, fx, { transitions: true });
      expect(fx.lastFrame()).toMatchObject({ basis: "fresh", fades: [] });
    } finally {
      first.dispose();
      reloaded.dispose();
    }
  });

  test("leaving arrange mode shows the bar at once", () => {
    const on = renderer(ROW);
    try {
      const fx = new SessionEffects<RenderedLine>("s");
      on.session.set("s", "edit.mode", "arrange");
      on.render({ shown: true, when: at(0) }, fx, { transitions: true });
      on.session.set("s", "edit.mode", "closed");
      on.render({ shown: true, when: at(1) }, fx, { transitions: true });
      expect(fx.lastFrame()).toMatchObject({ basis: "fresh", fades: [] });
    } finally {
      on.dispose();
    }
  });
});

describe("a render that throws leaves the last drawn frame to compare against", () => {
  const item = (id: string): RowItem => ({
    owner: new RichText(id, { end: "" }),
    placement: {
      id,
      effect: "bar",
      ground: DEFAULT_TERMINAL_THEME.backgroundColor,
    },
  });
  const fades = {
    transitions: true,
    source: { config: ROW, preset: "default", revision: 0, width: 80 },
    // A line names the placement that drew it; a line naming another hangs
    // under it.
    returned: (id: string, lines: readonly string[]) => ({
      drawing: lines.includes(id)
        ? {
            own: lines.filter((line) => line === id),
            opened: false,
            ground: DEFAULT_TERMINAL_THEME.backgroundColor,
          }
        : null,
      deeper: lines.filter((line) => line !== id),
    }),
    hold: (line: string) => line,
  };
  const left = ["left"];

  test("a frame never drawn is never compared against", () => {
    const fx = new SessionEffects<string>("s");
    const memory = new FrameMemory<string>();
    const first = framed(fx, memory, "none", fx.clockAt(at(0), 1), fades);
    first.placed("left", left);
    first.row("r", "bar", [item("left")]);
    first.drawn();
    // The next render's walk finds `left` gone, then it throws before its
    // first row: it is never drawn, so `left` never began leaving.
    framed(fx, memory, "none", fx.clockAt(at(1), 1), fades).placed("left", []);
    const after = framed(fx, memory, "none", fx.clockAt(at(2), 1), fades);
    after.placed("left", left);
    after.row("r", "bar", [item("left")]);
    after.drawn();
    expect(fx.lastFrame()).toMatchObject({
      basis: "compared",
      fades: [],
      leaves: [],
    });
  });
  test("a placement that laid no cell of its own draws what it returned, and is kept as nothing", () => {
    const fx = new SessionEffects<string>("s");
    const memory = new FrameMemory<string>();
    framed(fx, memory, "none", fx.clockAt(at(0), 1), fades).drawn();
    const motion = framed(fx, memory, "none", fx.clockAt(at(1), 1), fades);
    expect(motion.placed("left", ["right"])).toEqual(["right"]);
    motion.drawn();
    expect(fx.heldCount).toBe(0);
  });

  test("a placement reached twice in one frame is a loud error", () => {
    const fx = new SessionEffects<string>("s");
    const memory = new FrameMemory<string>();
    const motion = framed(fx, memory, "none", fx.clockAt(at(0), 1), fades);
    motion.placed("left", left);
    expect(() => motion.placed("left", left)).toThrow(
      'placement "left" was reached twice in one frame',
    );
  });
});

describe("a session's state revision moves with every change to it, whoever writes it", () => {
  test("a write of a value it did not hold moves it; one it held does not", () => {
    const state = new SessionState();
    expect(state.revision("s")).toBe(0);
    state.set("s", "theme", "nord");
    const set = state.revision("s");
    expect(set).toBeGreaterThan(0);
    state.set("s", "theme", "nord");
    state.setBatch("s", [{ key: "theme", value: "nord" }]);
    expect(state.revision("s")).toBe(set);
    state.setBatch("s", [
      { key: "theme", value: "nord" },
      { key: "style", value: "dim" },
    ]);
    expect(state.revision("s")).toBeGreaterThan(set);
  });

  test("a clear of a key it held moves it; of one it did not, does not", () => {
    const state = new SessionState();
    state.set("s", "theme", "nord");
    state.set("s", "style", "dim");
    const before = state.revision("s");
    state.clear("s", "endcaps");
    expect(state.revision("s")).toBe(before);
    state.clear("s", "style");
    expect(state.revision("s")).toBeGreaterThan(before);
  });

  test("another session's write leaves it alone; an emptied session reads 0, and never repeats a revision", () => {
    const state = new SessionState();
    state.set("s", "theme", "nord");
    const mine = state.revision("s");
    state.set("t", "theme", "nord");
    expect(state.revision("s")).toBe(mine);
    state.clear("s", "theme");
    expect(state.revision("s")).toBe(0);
    state.set("s", "theme", "nord");
    expect(state.revision("s")).toBeGreaterThan(state.revision("t"));
  });

  test("the settings history's undo moves it, though it writes past the click's journal", () => {
    const state = new SessionState();
    const history = new SettingsHistory(state, () => {});
    const journal = history.begin();
    journal.sessionState.set("s", "theme", "nord");
    journal.commit();
    const before = state.revision("s");
    history.undo("s");
    expect(state.revision("s")).not.toBe(before);
  });
});
