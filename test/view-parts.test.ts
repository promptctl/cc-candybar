// [LAW:verifiable-goals] brandon-unfiled-3248.8ro6 step 6: a placement's parts
// are derived values of the view it is drawn in. A frame drawn between data
// changes evaluates only the parts that read the instant; a change evaluates
// the parts that read it; and a view kept across changes draws exactly what a
// view made fresh for each draws.

import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { SessionState } from "../src/daemon/session-state";
import { VERBS } from "../src/daemon/verbs";
import { parseEffects, VERB_DISPATCH } from "../src/click/wire";
import { parseHandlerUrl } from "../src/install/index";
import {
  drawPayload,
  registerDslConfig,
  type DrawnFrame,
  type RenderWarning,
} from "../src/dsl/render";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { instantOf, type Instant } from "../src/utils/instant";
import { recordRender, testVerbContext } from "./helpers/click";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { links, stripAnsi } from "./helpers/ansi";

const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 1,
  width: 200,
};

const A = instantOf(new Date(2026, 5, 4, 12, 34, 56));
const B = instantOf(new Date(2026, 5, 4, 12, 34, 57));

// A view of `config`: its store and registry, and the compile it draws with.
function viewOf(config: ValidatedConfig, sessionState = new SessionState()) {
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", sessionState);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
  const errors: string[] = [];
  const warnings: RenderWarning[] = [];
  const draw = (
    payload: object,
    at: Instant,
    opts: typeof OPTS = OPTS,
    selection = resolveEffectiveGlobals(config, () => null, () => false),
  ): DrawnFrame =>
    drawPayload(
      config,
      compiled,
      store,
      registry,
      payload,
      at,
      opts,
      {
        onSegmentError: (id, message) => errors.push(`${id}: ${message}`),
        onRenderWarning: (warning) => warnings.push(warning),
      },
      selection,
    );
  return { compiled, registry, errors, warnings, draw };
}

describe("a frame evaluates the parts whose inputs moved", () => {
  const CONFIG = parseAndValidate(
    "<test>",
    `{
      variables: { x: { kind: "input", path: "x", default: "" } },
      segments: {
        stamp: { template: "{{ unixEpoch now }}" },
        shown: { template: "x={{ .x }}" },
        still: { template: "unchanging" },
      },
      root: { h: ["stamp", "shown", "still"] },
    }`,
  );

  test("between data changes, only the part that reads the instant", () => {
    const view = viewOf(CONFIG);
    const first = view.draw({ x: "1" }, A);
    const second = view.draw({ x: "1" }, B);
    expect(first.evaluated).toBeGreaterThan(second.evaluated);
    // `stamp`'s body, the rate beside the settings door, which reads who the
    // frame is drawn for (`drawing.fps`, a draw projection), and the door's
    // own cell, whose indicator reads the draw's diagnostics; nothing else.
    expect(second.evaluated).toBe(3);
    expect(stripAnsi(second.text)).toContain(String(Math.floor(B)));
    expect(view.errors).toEqual([]);
  });

  test("a changed input, only the part that reads it besides", () => {
    const view = viewOf(CONFIG);
    view.draw({ x: "1" }, A);
    const changed = view.draw({ x: "2" }, A);
    // `stamp`'s body, the door's two cells, and `shown`'s body: `shown`'s
    // colours read no `x`.
    expect(changed.evaluated).toBe(4);
    expect(stripAnsi(changed.text)).toContain("x=2");
  });

  test("a wider strip, every part that fits a row to it", () => {
    const view = viewOf(CONFIG);
    view.draw({ x: "1" }, A);
    const wider = view.draw({ x: "1" }, A, { ...OPTS, width: 300 });
    expect(stripAnsi(wider.text)).toBe(
      stripAnsi(viewOf(CONFIG).draw({ x: "1" }, A, { ...OPTS, width: 300 }).text),
    );
  });
});

describe("what reads the instant is a projection, however it reaches the clock", () => {
  test("a template binding an action whose own text reads the instant", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        actions: { copyNow: { copy: "{{ unixEpoch now }}" } },
        segments: { stamp: { template: '{{ action "copyNow" "copy" }}' } },
        root: { h: ["stamp"] },
      }`,
    );
    const view = viewOf(config);
    const urls = [A, B].map(
      (at) =>
        links(view.draw({}, at).text).find((l) => stripAnsi(l.text) === "copy")!
          .url,
    );
    expect(urls[0]).toContain(String(Math.floor(A)));
    expect(urls[1]).toContain(String(Math.floor(B)));
    expect(view.errors).toEqual([]);
  });

  // [LAW:no-silent-failure] A name the template computes may be any declared
  // action's, so it reads the instant when any action's own text does.
  test("a template binding an action by a name it computes", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        actions: { copyNow: { copy: "{{ unixEpoch now }}" } },
        segments: { stamp: { template: '{{ $a := "copyNow" }}{{ action $a "copy" }}' } },
        root: { h: ["stamp"] },
      }`,
    );
    const view = viewOf(config);
    const urls = [A, B].map(
      (at) =>
        links(view.draw({}, at).text).find((l) => stripAnsi(l.text) === "copy")!
          .url,
    );
    expect(urls[0]).toContain(String(Math.floor(A)));
    expect(urls[1]).toContain(String(Math.floor(B)));
    expect(view.errors).toEqual([]);
  });

  test("a layout whose gates read the instant", () => {
    const gated = (when: string) =>
      viewOf(
        parseAndValidate(
          "<test>",
          `{
            segments: { a: { template: "a" } },
            root: { v: [{ h: ["a"], when: ${JSON.stringify(when)} }] },
          }`,
        ),
      ).compiled.layoutReadsInstant;
    expect(gated("{{ gt (unixEpoch now) 0 }}")).toBe(true);
    expect(gated("true")).toBe(false);
  });

  // [LAW:no-silent-failure] The fold reads names; a template reaching a
  // projection by one it does not spell is kept, and its read of the clock is
  // refused where it happens, on the placement's ⚠.
  test("a clock read the fold cannot see is the placement's failure", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        variables: { clock: { kind: "time", layout: "15:04:05" } },
        segments: { hidden: { template: '{{ index . "clock" }}' } },
        root: { h: ["hidden"] },
      }`,
    );
    const view = viewOf(config);
    view.draw({}, A);
    expect(view.errors.join("\n")).toMatch(/keeps its answer/);
  });
});

// A part's answer is the template's alone: the same whichever template first
// asks it, at whichever point of the draw, so keeping it keeps nothing of
// where it was asked.
describe("a kept part keeps nothing of where it was first asked", () => {
  const THEMES = `actions: { applyTheme: { set: "theme", from: "themes" } },`;

  test("a placement's gate is evaluated outside every segment", () => {
    // `preview` lays out the bar, `gated` among it, so `gated`'s gate is first
    // asked inside `preview`'s body, where a segment is active; the walk asks
    // it between segments, where `bgOf` has no segment to read.
    const view = viewOf(
      parseAndValidate(
        "<test>",
        `{
          segments: {
            preview: { template: "{{ layoutPreview }}" },
            gated: { template: "g", when: '{{ ne (bgOf) "" }}' },
          },
          root: { v: [{ h: ["preview"] }, { h: ["gated"] }] },
        }`,
      ),
    );
    for (const at of [A, B]) {
      view.errors.length = 0;
      view.draw({}, at);
      expect(view.errors).toEqual([
        expect.stringMatching(/^gated: .*only available inside a segment/),
      ]);
    }
  });

  test("a globals rule reads no look, at the first draw or any after", () => {
    const view = viewOf(
      parseAndValidate(
        "<test>",
        `{
          ${THEMES}
          globals: { style: '{{ swatch "applyTheme" }}' },
          segments: { s: { template: "s" } },
          root: { h: ["s"] },
        }`,
        new Set(listResolvablePaletteNames()),
      ),
    );
    for (const at of [A, B]) {
      view.warnings.length = 0;
      view.draw({}, at);
      expect(view.warnings).toEqual([
        expect.objectContaining({
          kind: "rule",
          slot: "style",
          message: expect.stringMatching(
            /read the render's look before it was resolved/,
          ),
        }),
      ]);
    }
  });

  test("a swatch reads no clock, so its cell is kept between frames", () => {
    const view = viewOf(
      parseAndValidate(
        "<test>",
        `{
          ${THEMES}
          segments: { s: { template: '{{ swatch "applyTheme" }}' } },
          root: { h: ["s"] },
        }`,
        new Set(listResolvablePaletteNames()),
      ),
    );
    view.draw({}, A);
    // The settings door's two cells alone, which read who the frame is drawn
    // for and the draw's diagnostics.
    expect(view.draw({}, B).evaluated).toBe(2);
    expect(view.errors).toEqual([]);
  });

  // [LAW:no-silent-failure] An action no declaration names reads nothing:
  // the rule binding it is refused where it is evaluated, never the compile.
  test("a rule binding an undeclared action fails as a rule", () => {
    const view = viewOf(
      parseAndValidate(
        "<test>",
        `{
          globals: { style: '{{ $a := action "ghost" "?" }}none' },
          segments: { s: { template: "s" } },
          root: { h: ["s"] },
        }`,
      ),
    );
    view.draw({}, A);
    expect(view.warnings).toEqual([
      expect.objectContaining({
        kind: "rule",
        message: expect.stringMatching(/action "ghost" is not declared/),
      }),
    ]);
  });
});

// A view kept across a session's clicks, theme and look picks, a narrower
// terminal and new data draws, at every step, the bytes a view made fresh for
// that step draws: nothing a part reads escapes what it tracks.
describe("a kept view draws what a fresh one draws", () => {
  const SID = "parts";
  const config = parseAndValidate(
    "<user>",
    "{}",
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );

  test("through the bundled bar's clicks and picks", async () => {
    const sessionState = new SessionState();
    const kept = viewOf(config, sessionState);
    recordRender(sessionState, SID);
    const ctx = testVerbContext(sessionState, undefined, config);
    let width = 200;
    let model = "Opus 4.7";
    let last = "";
    const selection = () =>
      resolveEffectiveGlobals(
        config,
        (key) => sessionState.get(SID, key),
        () => false,
      );
    const payload = () => {
      const effective = selection();
      return {
        hook_event_name: "Status",
        session_id: SID,
        cwd: "/tmp",
        model: { id: "claude-opus-4-7", display_name: model },
        workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
        endcaps: { effective: effective.endcaps },
        preset: { effective: effective.preset },
        autoWrap: { effective: true },
        padding: { effective: 0 },
        colorCompatibility: { effective: effective.colorCompatibility },
        variation: { effective: effective.variation },
        shade: { effective: effective.shade },
      };
    };
    const step = (): number => {
      const at = instantOf(new Date());
      const opts = { ...OPTS, padding: 0, width };
      const drawn = kept.draw(payload(), at, opts, selection());
      const fresh = viewOf(config, sessionState);
      const anew = fresh.draw(payload(), at, opts, selection()).text;
      fresh.registry.dispose();
      expect(stripAnsi(drawn.text)).toBe(stripAnsi(anew));
      expect(drawn.text).toBe(anew);
      last = drawn.text;
      return drawn.evaluated;
    };
    const clickText = async (text: string): Promise<void> => {
      const hit = links(last).find((l) => stripAnsi(l.text) === text);
      if (hit === undefined) {
        throw new Error(
          `no link "${text}" in:\n${stripAnsi(last)}\nlinks: ${links(last)
            .map((l) => JSON.stringify(stripAnsi(l.text)))
            .join(" ")}`,
        );
      }
      const { verb, value } = parseHandlerUrl(hit.url);
      const effects =
        verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
      for (const e of effects) await VERBS.get(e.verb)!(e.value, ctx);
    };

    const cold = step();
    expect(step()).toBeLessThan(cold);
    await clickText("🍫");
    step();
    await clickText("🎨 look");
    step();
    sessionState.set(SID, "theme", listResolvablePaletteNames()[3]!);
    step();
    sessionState.set(SID, "style", "vivid");
    sessionState.set(SID, "variation", "duo");
    sessionState.set(SID, "shade", "brightest");
    step();
    width = 90;
    step();
    model = "Sonnet 4.7";
    step();
    await clickText("✖");
    step();
    sessionState.set(SID, "preset", "compact");
    step();
    expect(kept.errors).toEqual([]);
  });
});
