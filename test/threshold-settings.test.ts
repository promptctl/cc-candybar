// [LAW:verifiable-goals] brandon-settings-coverage-g4p.lx2 — the bundled
// thresholds and budgets are per-placement settings, driven through the real
// spine: the bundled default merged under a file, its synthesis, the render,
// and configure mode's clicks dispatched through the real verb handlers.
//
//   - Lowering block's warning threshold from the bar recolours the cell on
//     the next render.
//   - A pick that would put a ramp's stops out of order is refused with a
//     reason naming both settings — never written, never sorted.
//   - A file that puts them out of order, or still declares a retired
//     threshold variable, fails to load and says what to write instead.

import { configurePlacement } from "./helpers/configure";
import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { resolveThemeSelection } from "../src/themes/palette-resolvers";
import { testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import { VERBS, type VerbContext } from "../src/daemon/verbs";
import {
  configureMember,
  EDIT_MODE_KEY,
} from "../src/config/loader/edit-mode";
import { placementDraftKey } from "../src/config/edit-chrome";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { durableConfig, type DurableConfig } from "./helpers/durable-config";
import { linkUrls } from "./helpers/ansi";

const ALLOWED = new Set(listResolvablePaletteNames());
const SID = "s1";
const THEME = "textual-dark";
const RESETS_AT = 4_102_444_800; // 2100-01-01 — `when: gt .resetsAt 0` fires

const withRoot = (root: string): string => `{ root: ${root} }`;
const BLOCK_ONLY = withRoot("{ v: [ { h: ['block'] } ] }");

const load = (src: string) =>
  parseAndValidate("<test>", src, ALLOWED, DEFAULT_DSL_CONFIG);

let durable: DurableConfig;
beforeEach(() => {
  durable = durableConfig("cc-candybar-thresholds-");
});
afterEach(() => {
  durable.dispose();
});

function buildRuntime(src: string, utilization: number) {
  durable.write(src);
  const config = load(src);
  const sessionState = new SessionState();
  durable.seedOrigin(sessionState, SID);
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
  const render = (): string =>
    renderDsl(
      config,
      compiled,
      store,
      registry,
      {
        session_id: SID,
        project_dir: "/tmp/proj",
        block: { nativeUtilization: utilization, resetsAt: RESETS_AT },
      },
      {
        endcaps: "powerline" as const,
        colorCompatibility: "truecolor" as const,
        wrap: true,
        padding: 0,
        charset: "unicode" as const,
        width: 200,
      },
      undefined,
      { theme: resolveThemeSelection(undefined, null, THEME) },
    );
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, durable.historyFor(sessionState)),
    configFor: () => config,
  };
  // Through the verb the URL names — `dispatch` included, which is what
  // turns a refused effect into the bar's transient `click.error`.
  const click = (url: string): void => {
    const { verb, value } = parseHandlerUrl(url);
    VERBS.get(verb)!(value, ctx);
  };
  // The one stepper link that steps `setting` of `id` by `by`.
  const stepper = (id: string, setting: string, by: number): string => {
    const key = placementDraftKey("default", id, setting);
    const hits = linkUrls(render()).filter((u) =>
      effectsOf(u).some((e) => e.args[1] === key && e.args[2] === String(by)),
    );
    expect(hits).toHaveLength(1);
    return hits[0]!;
  };
  const pick = (id: string, setting: string): string | null =>
    sessionState.get(SID, placementDraftKey("default", id, setting));
  return { sessionState, render, click, stepper, pick };
}

// The `48;2;r;g;b` background SGR a palette role is drawn with.
const bgSgr = (role: string): string => {
  const hex = getThemePalette(THEME)!.get(role)!.hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `48;2;${r};${g};${b}`;
};

describe("block's thresholds are settings configure mode steps", () => {
  test("lowering the warning threshold from the bar recolours the cell on the next render", () => {
    const rt = buildRuntime(BLOCK_ONLY, 45);
    configurePlacement(rt.sessionState, SID, "default", "block");
    // 45% sits under the bundled warnAt of 50: calm.
    expect(rt.render()).not.toContain(bgSgr("warning"));
    // The stepper strides by the declared step, 5: one click lands on 45.
    rt.click(rt.stepper("block", "warnAt", -5));
    expect(rt.pick("block", "warnAt")).toBe("45");
    expect(rt.render()).toContain(bgSgr("warning"));
  });

  test("a step that would drop errorAt below warnAt is refused, naming both", () => {
    const rt = buildRuntime(BLOCK_ONLY, 10);
    configurePlacement(rt.sessionState, SID, "default", "block");
    // 80 → 50 in six clicks: equal thresholds are a hard edge, and allowed.
    for (let i = 0; i < 6; i++) rt.click(rt.stepper("block", "errorAt", -5));
    expect(rt.pick("block", "errorAt")).toBe("50");
    const down = rt.stepper("block", "errorAt", -5);
    const reason =
      /refused — placement "block": "errorAt" \(45\) is below "warnAt" \(50\) — error at % must be at least warning at %/;
    expect(() => rt.click(down)).toThrow(reason);
    expect(rt.pick("block", "errorAt")).toBe("50");
    // The reason is what the next render's strip shows.
    expect(rt.sessionState.get(SID, "click.error")).toMatch(reason);
    // The other way round is the same relation: warnAt may not climb past it.
    const up = rt.stepper("block", "warnAt", 5);
    expect(() => rt.click(up)).toThrow(/"errorAt" \(50\) is below "warnAt" \(55\)/);
    expect(rt.pick("block", "warnAt")).toBeNull();
  });

  test("a set-state batch holding a descending pair is refused whole", () => {
    const rt = buildRuntime(BLOCK_ONLY, 10);
    const warn = placementDraftKey("default", "block", "warnAt");
    const error = placementDraftKey("default", "block", "errorAt");
    const setState = VERBS.get("set-state")!;
    const ctx = {
      ...testVerbContext(rt.sessionState, durable.historyFor(rt.sessionState)),
      configFor: () => load(BLOCK_ONLY),
    };
    expect(() =>
      setState(`${SID}/${warn}/70/${error}/60`, ctx),
    ).toThrow(/"errorAt" \(60\) is below "warnAt" \(70\)/);
    expect(rt.pick("block", "warnAt")).toBeNull();
    // Raising both together is one write that stands.
    setState(`${SID}/${warn}/85/${error}/90`, ctx);
    expect(rt.pick("block", "warnAt")).toBe("85");
    expect(rt.pick("block", "errorAt")).toBe("90");
  });
});

describe("a stride wider than 1 reaches both ends", () => {
  test("a step past a bound stops on it; only a step from the bound wraps", () => {
    const rt = buildRuntime(withRoot("{ v: [ { h: ['session'] } ] }"), 0);
    configurePlacement(rt.sessionState, SID, "default", "session");
    const budget = placementDraftKey("default", "session", "budget");
    rt.sessionState.set(SID, budget, "9998");
    rt.click(rt.stepper("session", "budget", 5));
    expect(rt.pick("session", "budget")).toBe("10000");
    rt.click(rt.stepper("session", "budget", 5));
    expect(rt.pick("session", "budget")).toBe("0");
    rt.sessionState.set(SID, budget, "3");
    rt.click(rt.stepper("session", "budget", -5));
    expect(rt.pick("session", "budget")).toBe("0");
    rt.click(rt.stepper("session", "budget", -5));
    expect(rt.pick("session", "budget")).toBe("10000");
  });
});

describe("the loader holds the file to the same order", () => {
  test("an atLeast cycle fails to load, once", () => {
    const src = `{
      segments: {
        gauge: {
          template: '{{ .settings.low }}{{ .settings.high }}',
          settings: {
            low: { label: 'low', domain: { min: 0, max: 9, atLeast: 'high' }, default: 5 },
            high: { label: 'high', domain: { min: 0, max: 9, atLeast: 'low' }, default: 5 },
          },
        },
      },
      root: { v: [ { h: ['gauge'] } ] },
    }`;
    let message = "";
    try {
      load(src);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(
      /segments\.gauge\.settings\.high: atLeast closes a cycle \(high ≥ low ≥ high\)/,
    );
    expect(message.match(/closes a cycle/g)).toHaveLength(1);
  });

  test("defaults out of order are reported at the declaration only, not per placement", () => {
    const src = `{
      segments: {
        gauge: {
          template: '{{ .settings.low }}{{ .settings.high }}',
          settings: {
            low: { label: 'low', domain: { min: 0, max: 9 }, default: 5 },
            high: { label: 'high', domain: { min: 0, max: 9, atLeast: 'low' }, default: 2 },
          },
        },
      },
      root: { v: [ { h: ['gauge'] } ] },
    }`;
    let message = "";
    try {
      load(src);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.match(/is below "low"/g)).toHaveLength(1);
  });

  test("a template still reading a retired threshold names the setting that replaced it", () => {
    const src = `{ segments: { mine: { template: '{{ .burn.eta.warnMinutes }}' } } }`;
    expect(() => load(src)).toThrow(
      /unknown variable "\.burn\.eta\.warnMinutes" — "\.burn\.eta\.warnMinutes" is no longer a variable: it became the "warnWithin" setting of each "burnrate" placement .*; a "burnrate" template reads it as "\.settings\.warnWithin"/,
    );
  });


  test("a placement whose thresholds descend fails to load", () => {
    expect(() =>
      load(
        withRoot(
          "{ v: [ { h: [ { seg: 'block', settings: { warnAt: 60, errorAt: 55 } } ] } ] }",
        ),
      ),
    ).toThrow(/placement "block" of segment "block": "errorAt" \(55\) is below "warnAt" \(60\)/);
  });

  test("burnrate's minutes run the other way: errorWithin may not pass warnWithin", () => {
    expect(() =>
      load(
        withRoot(
          "{ v: [ { h: [ { seg: 'burnrate', settings: { errorWithin: 90 } } ] } ] }",
        ),
      ),
    ).toThrow(/"warnWithin" \(60\) is below "errorWithin" \(90\)/);
  });

  test("atLeast must name another range setting of the segment", () => {
    const src = `{
      segments: {
        gauge: {
          template: '{{ .settings.low }}',
          settings: {
            low: { label: 'low', domain: { min: 0, max: 9, atLeast: 'high' }, default: 1 },
            flag: { label: 'flag', domain: 'bool', default: true },
          },
        },
      },
      root: { v: [ { h: ['gauge'] } ] },
    }`;
    expect(() => load(src)).toThrow(
      /segments\.gauge\.settings\.low: atLeast "high" must name another range setting of this segment \(its range settings: none\)/,
    );
  });

  test("defaults that do not stand together fail to load", () => {
    const src = `{
      segments: {
        gauge: {
          template: '{{ .settings.low }}{{ .settings.high }}',
          settings: {
            low: { label: 'low', domain: { min: 0, max: 9 }, default: 5 },
            high: { label: 'high', domain: { min: 0, max: 9, atLeast: 'low' }, default: 2 },
          },
        },
      },
      root: { v: [ { h: ['gauge'] } ] },
    }`;
    expect(() => load(src)).toThrow(
      /segments\.gauge\.settings\.high: the defaults do not stand together: "high" \(2\) is below "low" \(5\)/,
    );
  });

  test("a range's step is a whole number of at least 1", () => {
    const src = `{
      segments: {
        gauge: {
          template: '{{ .settings.n }}',
          settings: { n: { label: 'n', domain: { min: 0, max: 9, step: 0 }, default: 1 } },
        },
      },
      root: { v: [ { h: ['gauge'] } ] },
    }`;
    expect(() => load(src)).toThrow(/a whole step ≥ 1/);
  });

  test("a retired threshold variable fails to load, naming the setting that replaced it", () => {
    const src = `{ variables: { 'block.budget.warningThreshold': { kind: 'literal', value: 70 } } }`;
    expect(() => load(src)).toThrow(
      /variables\.block\.budget\.warningThreshold is no longer read: it became the "errorAt" setting of each "block" placement/,
    );
  });
});
