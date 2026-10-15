// [LAW:verifiable-goals] brandon-effects-2gka.631: a placement fades in when it
// appears. One whose `when` turns true between two frames drawn from the same
// config fades in over 20 s, its cells alone; a first render, a click and a
// reload settle the bar, so nothing they reveal fades.

import { decodeAnsi, resolveColorRef } from "@promptctl/rich-js";

import { SessionState } from "../src/daemon/session-state";
import { VERBS } from "../src/daemon/verbs";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { EffectSessions, SessionEffects } from "../src/render/effect";
import { resolvedStyle } from "../src/render/rich-theme";
import { decideEffectName, type EffectName } from "../src/themes";
import type { Instant } from "../src/utils/instant";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { recordRender, testVerbContext } from "./helpers/click";
import { stripAnsi } from "./helpers/ansi";

const START = 1_800_000_000 as Instant;
const at = (seconds: number): Instant => (START + seconds) as Instant;
// The instant the middle placement's `when` turns true.
const S = 30;

// A row whose middle placement shows while the payload says so, and a group
// whose body a click opens.
const config = (globals = "{}"): ValidatedConfig =>
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
        { h: ["left", "middle", "right"] },
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
// same compiled config, as a render cache entry's are until it reloads.
function renderer(cfg: ValidatedConfig, session = new SessionState()) {
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, session);
  const compiled = registerDslConfig(cfg, registry, { cwd: "/tmp" });
  const opts = {
    endcaps: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    wrap: true,
    padding: 1,
    charset: "unicode" as const,
    width: 160,
  };
  return {
    session,
    // The palette the latest render wore.
    palette: () => compiled.menuRuntime.action.palette,
    render: (
      { shown, when }: Frame,
      effects: SessionEffects,
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
        {
          effect: decideEffectName(selection.bar ?? "none"),
          effects,
          ...(selection.transitions !== undefined && {
            transitions: selection.transitions,
          }),
        },
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
        const onFx = new SessionEffects("s");
        const offFx = new SessionEffects("s");
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

  test("it rises from the theme's background, not the terminal the loops assume", () => {
    const on = renderer(ROW);
    try {
      const fx = new SessionEffects("s");
      on.render({ shown: false, when: at(0) }, fx, { transitions: true });
      const row = on.render({ shown: true, when: at(S) }, fx, { transitions: true }).split("\n")[0]!;
      const ground = resolveColorRef(on.palette(), "background").hex.toLowerCase();
      const text = decodeAnsi(row);
      const col = text.plain.indexOf("MIDDLE");
      for (let i = col; i < col + "MIDDLE".length; i++) {
        const style = resolvedStyle(
          text.spans.find(({ start, end }) => start <= i && i < end)!.style,
        );
        // Wholly veiled at its t = 0: ink and fill both the ground.
        expect(style.bgcolor?.name.toLowerCase()).toBe(ground);
        expect(style.color?.name.toLowerCase()).toBe(ground);
      }
      expect(ground).not.toBe("#000000");
    } finally {
      on.dispose();
    }
  });

  test("its event says what the frame compared against, and what is fading in on what clock", () => {
    const on = renderer(ROW);
    try {
      const fx = new SessionEffects("s");
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
    } finally {
      on.dispose();
    }
  });

  test("a config's globals.transitions turns it on for a caller that resolves none", () => {
    const on = renderer(config("{ transitions: true }"));
    const off = renderer(ROW);
    try {
      const onFx = new SessionEffects("s");
      const offFx = new SessionEffects("s");
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

describe("nothing fades in where the bar settles", () => {
  test("the first render draws every placement at once", () => {
    const on = renderer(ROW);
    const off = renderer(ROW);
    try {
      const frame = { shown: true, when: at(S) };
      expect(on.render(frame, new SessionEffects("s"), { transitions: true })).toBe(
        off.render(frame, new SessionEffects("s"), { transitions: false }),
      );
    } finally {
      on.dispose();
      off.dispose();
    }
  });

  test("a click settles: a disclosure it opens, and a fade in flight, show at once", () => {
    const on = renderer(ROW);
    const off = renderer(ROW, on.session);
    try {
      const fx = new SessionEffects("s");
      on.render({ shown: false, when: at(0) }, fx, { transitions: true });
      // Mid-fade, the click lands: the group opens, the fade ends.
      on.render({ shown: true, when: at(S) }, fx, { transitions: true });
      on.session.set("s", "groups.more", "more");
      fx.settle();
      const frame = { shown: true, when: at(S + 5) };
      const opened = on.render(frame, fx, { transitions: true });
      expect(stripAnsi(opened)).toContain("EXTRA");
      expect(fx.lastFrame()).toMatchObject({ basis: "fresh", fades: [] });
      expect(opened).toBe(
        off.render(frame, new SessionEffects("s"), { transitions: false }),
      );
    } finally {
      on.dispose();
      off.dispose();
    }
  });

  test("without the click's settle, the body it opened would fade in", () => {
    const on = renderer(ROW);
    try {
      const fx = new SessionEffects("s");
      on.render({ shown: false, when: at(0) }, fx, { transitions: true });
      on.session.set("s", "groups.more", "more");
      on.render({ shown: false, when: at(1) }, fx, { transitions: true });
      expect(fx.lastFrame().fades.map((f) => f.placement)).toContain("extra");
    } finally {
      on.dispose();
    }
  });

  test("a reload settles: a frame drawn from another load of the config compares against nothing", () => {
    const first = renderer(ROW);
    const reloaded = renderer(ROW);
    try {
      const fx = new SessionEffects("s");
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
      const fx = new SessionEffects("s");
      on.session.set("s", "edit.mode", "arrange");
      on.render({ shown: true, when: at(0) }, fx, { transitions: true });
      // ✓ done is a click: it writes edit.mode, and the journal settles.
      on.session.set("s", "edit.mode", "closed");
      fx.settle();
      on.render({ shown: true, when: at(1) }, fx, { transitions: true });
      expect(fx.lastFrame()).toMatchObject({ basis: "fresh", fades: [] });
    } finally {
      on.dispose();
    }
  });
});

describe("the verb journal settles every session a click changed", () => {
  const click = (value: string, settled: string[]) => {
    const session = new SessionState();
    recordRender(session, "s");
    const ctx = {
      ...testVerbContext(session, undefined, ROW),
      settle: (sid: string) => settled.push(sid),
    };
    VERBS.get("set-state")!(value, ctx);
    return { session, ctx };
  };

  test("a write that changes the session's state settles it", () => {
    const settled: string[] = [];
    click("s/theme/nord", settled);
    expect(settled).toEqual(["s"]);
  });

  test("a write of the value already there changes nothing and settles nothing", () => {
    const settled: string[] = [];
    const { ctx } = click("s/theme/nord", settled);
    settled.length = 0;
    VERBS.get("set-state")!("s/theme/nord", ctx);
    expect(settled).toEqual([]);
  });

  test("the daemon's memory settles the session the click named, and no other", () => {
    const sessions = new EffectSessions();
    const on = renderer(ROW);
    try {
      for (const sid of ["s", "t"]) {
        on.render({ shown: false, when: at(0) }, sessions.of(sid), { transitions: true });
      }
      sessions.settle("s");
      on.render({ shown: true, when: at(1) }, sessions.of("s"), { transitions: true });
      on.render({ shown: true, when: at(1) }, sessions.of("t"), { transitions: true });
      expect(sessions.of("s").lastFrame().fades).toEqual([]);
      expect(sessions.of("t").lastFrame().fades).toEqual([{ placement: "middle", t: 0 }]);
      // A session it holds no memory for has nothing to settle.
      expect(() => sessions.settle("nobody")).not.toThrow();
    } finally {
      on.dispose();
    }
  });
});
