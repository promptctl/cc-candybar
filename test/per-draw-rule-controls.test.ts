// [LAW:verifiable-goals] A control that centres on a key's value — a carousel,
// a picker, a swatches row, the swatch of the option in force — over a theme,
// style or effect a rule chooses PER DRAW (a rule reading `now`) marks the
// option the bar wears at the instant drawn, and its arrows step from that
// option. The rule's answer exists only in a draw, so one rig is drawn at
// alternating instants: a reader that kept the first draw's answer, or the
// floor under the rule, shows here.

import { linksOf, effectsOf } from "../src/click/read";
import { textOf, type Frame, type Run } from "../src/render/frame";
import { instantOf, type Instant } from "../src/utils/instant";
import { listResolvablePaletteNames, EFFECT_NAMES } from "../src/themes/policy";
import { CAROUSEL_NEXT, CAROUSEL_PREV } from "../src/render/carousel";
import { SWATCHES_RANDOM } from "../src/render/swatches";
import { landing, STEP_RANDOM } from "../src/render/option-ring";
import { boldUrls } from "./helpers/frame";
import { clickUrl } from "./helpers/click";
import { buildRig, DEFAULT_DSL_CONFIG } from "./helpers/rig";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const SID = sessionIdOf("7o3");
const THEMES = listResolvablePaletteNames();

// Two instants the rule tells apart by their second, in local time as `date`
// formats it.
const EVEN = instantOf(new Date(2026, 5, 4, 12, 0, 2));
const ODD = instantOf(new Date(2026, 5, 4, 12, 0, 3));
const rule = (even: string, odd: string): string =>
  `{{ if eq (date "05" now) "02" }}${even}{{ else }}${odd}{{ end }}`;

// The controls over one key, a row each. Every option domain has a picker and
// a carousel; a colour-valued one also has a swatches row and the swatch of
// the option in force, after a label that finds it.
const CONTROLS = {
  car: '{{ carousel "apply" "open" "Pick" }}',
  pk: '{{ picker "apply" "page" false true }}',
};
const COLOUR_CONTROLS = {
  ...CONTROLS,
  sw: '{{ swatches "apply" "page" }}',
  held: 'held {{ swatch "apply" }}',
};

// A config with `segments` over `key`, whose options are `from` (a domain's
// name, or its members), and whose `field` the globals' `ruled` decides.
const controls = (
  field: string,
  key: string,
  from: string | readonly string[],
  ruled: string,
  segments: Readonly<Record<string, string>>,
) => `{
  globals: { ${field}: '${ruled}' },
  variables: { page: { kind: 'state', key: 'page', default: '0' } },
  actions: {
    apply: { set: '${key}', from: ${JSON.stringify(from)} },
    page: { set: 'page', int: true },
    open: { set: 'opened', to: 'yes' },
  },
  segments: ${JSON.stringify(
    Object.fromEntries(
      Object.entries(segments).map(([name, template]) => [name, { template }]),
    ),
  )},
  root: { rows: { ${Object.keys(segments)
    .map((name) => `${name}: { h: ['${name}'] }`)
    .join(", ")}, status: { h: [] } } },
}`;

const rigOf = (source: string) => {
  const rig = buildRig({ source, base: DEFAULT_DSL_CONFIG, sessionId: SID });
  const draw = (at: Instant): Frame =>
    rig.draw({ opts: { width: 400, wrap: true }, at }).frame;
  // The link drawn as `glyph` that steps the controls' own action: the
  // bundled default draws glyphs of its own, a `?` among them.
  const urlOf = (frame: Frame, glyph: string): string => {
    const hit = linksOf(frame).find(
      (l) =>
        l.text === glyph && effectsOf(l.url).some((e) => e.args[1] === "apply"),
    );
    if (hit === undefined)
      throw new Error(`no "${glyph}" stepping "apply" in: ${textOf(frame)}`);
    return hit.url;
  };
  return { ...rig, draw, urlOf };
};

// The option a link writes at `key`, when it writes one.
const writes = (url: string, key: string): string | undefined =>
  effectsOf(url).find((e) => e.args[1] === key)?.args[2];

// The options the picker lists, in the domain's order.
const listed = (frame: Frame, key: string): string[] => [
  ...new Set(linksOf(frame).flatMap((l) => writes(l.url, key) ?? [])),
];

// The colours of the swatch drawn after `label`: the cells of the three ▀
// that follow it on its row.
const swatchAfter = (frame: Frame, label: string): string[] => {
  const runs: Run[] = frame.rows.flatMap((row) => row.runs);
  const at = runs.findIndex((r) => r.text.trim() === label);
  if (at === -1) throw new Error(`no "${label}" in: ${textOf(frame)}`);
  return runs
    .slice(at + 1)
    .filter((r) => r.text === "▀")
    .slice(0, 3)
    .map((r) => `${r.fg}/${r.bg}`);
};

// The options the picker draws bold, its mark for the option in force.
const pickerMarks = (frame: Frame, key: string): string[] =>
  boldUrls(frame).flatMap((url) => writes(url, key) ?? []);

// What a frame draws as current, control by control: the picker's marks
// and the swatches row's bracketed swatch by the option they write, and the
// carousel label's and the held swatch's colours as the picker draws each
// option's own.
const current = (frame: Frame, key: string) => {
  const bySwatch = (label: string) =>
    listed(frame, key).filter(
      (option) =>
        swatchAfter(frame, option).join() === swatchAfter(frame, label).join(),
    );
  return {
    picker: pickerMarks(frame, key),
    swatches: linksOf(frame)
      .filter((l) => /^\[▀▀▀\]$/u.test(l.text))
      .flatMap((l) => writes(l.url, key) ?? []),
    carousel: bySwatch("Pick"),
    held: bySwatch("held"),
  };
};

describe.each([
  ["palette", "theme", "themes", ["nord", "dracula"]],
  ["style", "style", "styles", ["vivid", "muted"]],
] as const)(
  "a %s chosen per draw by a rule, over a colour-valued domain",
  (field, key, from, [even, odd]) => {
    test("every control marks the option the bar wears at each instant, in turn", () => {
      const rt = rigOf(controls(field, key, from, rule(even, odd), COLOUR_CONTROLS));
      for (const [at, worn] of [
        [EVEN, even],
        [ODD, odd],
        [EVEN, even],
        [ODD, odd],
      ] as const) {
        expect([worn, current(rt.draw(at), key)]).toEqual([
          worn,
          { picker: [worn], swatches: [worn], carousel: [worn], held: [worn] },
        ]);
      }
      rt.dispose();
    });
  },
);

describe.each([
  ["palette", "theme", "themes", ["nord", "dracula"]],
  ["style", "style", "styles", ["vivid", "muted"]],
  ["effect", "effect", EFFECT_NAMES, ["pulse", "sparkle"]],
] as const)("a %s chosen per draw by a rule", (field, key, from, [even, odd]) => {
  const SOURCE = controls(field, key, from, rule(even, odd), CONTROLS);

  test("the picker marks what the bar wears at each instant, and ▶ steps from it", async () => {
    const rt = rigOf(SOURCE);
    for (const [at, worn] of [
      [EVEN, even],
      [ODD, odd],
      [EVEN, even],
    ] as const) {
      expect([worn, pickerMarks(rt.draw(at), key)]).toEqual([worn, [worn]]);
    }
    rt.dispose();
    for (const [at, worn] of [
      [EVEN, even],
      [ODD, odd],
    ] as const) {
      const one = rigOf(SOURCE);
      const frame = one.draw(at);
      const options = listed(frame, key);
      await one.click(one.urlOf(frame, CAROUSEL_NEXT));
      expect([worn, one.sessionState.get(SID, key)]).toEqual([
        worn,
        options[options.indexOf(worn) + 1],
      ]);
      one.dispose();
    }
  });
});

describe("a theme chosen per draw by a rule, clicked", () => {
  const SOURCE = controls(
    "palette",
    "theme",
    "themes",
    rule("nord", "dracula"),
    COLOUR_CONTROLS,
  );
  const nord = THEMES.indexOf("nord");
  const dracula = THEMES.indexOf("dracula");

  test("N clicks on one ▶ with no redraw land N on from the theme the draw wore, and the pick then outranks the rule", async () => {
    const rt = rigOf(SOURCE);
    // The ODD draw comes between: the link keeps nothing of it.
    const next = rt.urlOf(rt.draw(EVEN), CAROUSEL_NEXT);
    rt.draw(ODD);
    const landed: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      await rt.click(next);
      landed.push(rt.sessionState.get(SID, "theme"));
    }
    expect(landed).toEqual(THEMES.slice(nord + 1, nord + 5));
    for (const at of [EVEN, ODD])
      expect(pickerMarks(rt.draw(at), "theme")).toEqual([THEMES[nord + 4]]);
    rt.dispose();
  });

  test("◀ steps back from the theme the draw wore", async () => {
    // Not first, so ◀ does not wrap.
    expect(dracula).toBeGreaterThan(0);
    const rt = rigOf(SOURCE);
    await rt.click(rt.urlOf(rt.draw(ODD), CAROUSEL_PREV));
    expect(rt.sessionState.get(SID, "theme")).toBe(THEMES[dracula - 1]);
    rt.dispose();
  });

  test("the swatches row's ? lands where a random step from the worn theme lands, at the click's instant", async () => {
    // A random step adds one offset to whichever centre it starts from, so at
    // one instant a step from nord and one from any other theme land apart.
    const at = instantOf(new Date(2026, 5, 4, 12, 0, 7));
    const rt = rigOf(SOURCE);
    const random = rt.urlOf(rt.draw(EVEN), SWATCHES_RANDOM);
    await clickUrl(random, { ...rt.ctx, now: () => at });
    expect(rt.sessionState.get(SID, "theme")).toBe(
      landing(THEMES, "nord", STEP_RANDOM, at),
    );
    rt.dispose();
  });
});
