// [LAW:verifiable-goals] A control that centres on a key's value, over a
// theme, style or effect a rule chooses PER DRAW (a rule reading `now`), shows
// the option the bar wears at the instant drawn, and its arrows step from that
// option: the picker marks it, and over a colour-valued domain the swatches
// row brackets it and the carousel label and the swatch of the option in force
// show its colours. The rule's answer exists only in a draw, so every rig is
// drawn at both instants: a reader that kept the first draw's answer, or the
// floor under the rule, shows here.

import { linksOf, effectsOf } from "../src/click/read";
import { VERB_SET_STATE, VERB_TURN_PAGE } from "../src/click/wire";
import { textOf, type Frame, type Row } from "../src/render/frame";
import { instantOf, type Instant } from "../src/utils/instant";
import { EFFECT_NAMES } from "../src/themes/policy";
import { CAROUSEL_NEXT, CAROUSEL_PREV } from "../src/render/carousel";
import { SWATCHES_RANDOM } from "../src/render/swatches";
import { landing, STEP_RANDOM } from "../src/render/option-ring";
import { boldUrls } from "./helpers/frame";
import { clickUrl } from "./helpers/click";
import { buildRig, DEFAULT_DSL_CONFIG, type Rig } from "./helpers/rig";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const SID = sessionIdOf("7o3");

// The rule answers its first option at second 02 and its second at any other
// second, in local time as `date` formats it.
const AT_02 = instantOf(new Date(2026, 5, 4, 12, 0, 2));
const AT_03 = instantOf(new Date(2026, 5, 4, 12, 0, 3));
const rule = (at02: string, other: string): string =>
  `{{ if eq (date "05" now) "02" }}${at02}{{ else }}${other}{{ end }}`;

// The row the control `tag` leads. A row opens on its endcap, so the tag is
// found as a run of its own.
const rowOf = (frame: Frame, tag: string): Row => {
  const row = frame.rows.find(({ runs }) =>
    runs.some((r) => r.text.trim() === tag),
  );
  if (row === undefined)
    throw new Error(`no "${tag}" row in: ${textOf(frame)}`);
  return row;
};
const linksOn = (frame: Frame, tag: string) =>
  linksOf({ rows: [rowOf(frame, tag)] });

// The option a link writes at `key`; a link that writes another key (a page
// cursor, the label's open) writes none.
const writes = (url: string, key: string): string | undefined =>
  effectsOf(url).find((e) => e.verb === VERB_SET_STATE && e.args[1] === key)
    ?.args[2];

const urlOn = (frame: Frame, tag: string, glyph: string): string => {
  const hit = linksOn(frame, tag).find((l) => l.text === glyph);
  if (hit === undefined)
    throw new Error(`no "${glyph}" on "${tag}" in: ${textOf(frame)}`);
  return hit.url;
};

// The colours of the swatch drawn after `label` on the row `tag` leads.
const swatchAfter = (frame: Frame, tag: string, label: string): string => {
  const { runs } = rowOf(frame, tag);
  const at = runs.findIndex((r) => r.text.trim() === label);
  if (at === -1)
    throw new Error(`no "${label}" on "${tag}" in: ${textOf(frame)}`);
  return runs
    .slice(at + 1)
    .filter((r) => r.text === "▀")
    .slice(0, 3)
    .map((r) => `${r.fg}/${r.bg}`)
    .join(" ");
};

// A control over the key, drawn on a row of its own led by its tag, so a
// reading of one control reads that row alone: the bundled default draws
// glyphs of its own. Its mark is what it shows as current, read from the
// frame, and what it shows while the bar wears `worn`. A carousel over a
// domain without colours draws a plain label, so it marks nothing.
interface Control {
  readonly tag: string;
  readonly template: string;
  readonly arrows: boolean;
  readonly mark?: {
    readonly shown: (frame: Frame, key: string) => unknown;
    readonly wearing: (frame: Frame, worn: string) => unknown;
  };
}

const CAROUSEL: Control = {
  tag: "car",
  template: '{{ carousel "apply" "open" "Pick" }}',
  arrows: true,
};
const SWATCH_CAROUSEL: Control = {
  ...CAROUSEL,
  mark: {
    shown: (frame) => swatchAfter(frame, "car", "Pick"),
    wearing: (frame, worn) => swatchAfter(frame, "pk", worn),
  },
};
const PICKER: Control = {
  tag: "pk",
  template: '{{ picker "apply" "page" false true }}',
  arrows: false,
  mark: {
    shown: (frame, key) => {
      const bold = new Set(boldUrls({ rows: [rowOf(frame, "pk")] }));
      return linksOn(frame, "pk").flatMap(
        (l) => (bold.has(l.url) && writes(l.url, key)) || [],
      );
    },
    wearing: (_, worn) => [worn],
  },
};
const SWATCHES: Control = {
  tag: "sw",
  template: '{{ swatches "apply" "page" }}',
  arrows: true,
  mark: {
    shown: (frame, key) =>
      linksOn(frame, "sw").flatMap(
        (l) => (l.text === "[▀▀▀]" && writes(l.url, key)) || [],
      ),
    wearing: (_, worn) => [worn],
  },
};
const HELD: Control = {
  tag: "held",
  template: '{{ swatch "apply" }}',
  arrows: false,
  mark: {
    shown: (frame) => swatchAfter(frame, "held", "held"),
    wearing: (frame, worn) => swatchAfter(frame, "pk", worn),
  },
};

interface Domain {
  readonly field: string;
  readonly key: string;
  readonly from: string | readonly string[];
  readonly at02: string;
  readonly at03: string;
  readonly controls: readonly Control[];
}

const COLOUR_CONTROLS = [SWATCH_CAROUSEL, PICKER, SWATCHES, HELD];
const DOMAINS: readonly Domain[] = [
  {
    field: "palette",
    key: "theme",
    from: "themes",
    at02: "nord",
    at03: "dracula",
    controls: COLOUR_CONTROLS,
  },
  {
    field: "style",
    key: "style",
    from: "styles",
    at02: "vivid",
    at03: "muted",
    controls: COLOUR_CONTROLS,
  },
  {
    field: "effect",
    key: "effect",
    from: EFFECT_NAMES,
    at02: "pulse",
    at03: "sparkle",
    controls: [CAROUSEL, PICKER],
  },
];

const sourceOf = (d: Domain): string => `{
  globals: { ${d.field}: '${rule(d.at02, d.at03)}' },
  variables: { page: { kind: 'state', key: 'page', default: '0' } },
  actions: {
    apply: { set: '${d.key}', from: ${JSON.stringify(d.from)} },
    page: { set: 'page', int: true },
    open: { set: 'opened', to: 'yes' },
  },
  segments: ${JSON.stringify(
    Object.fromEntries(
      d.controls.map((c) => [c.tag, { template: `${c.tag} ${c.template}` }]),
    ),
  )},
  root: { rows: { ${d.controls
    .map(({ tag }) => `${tag}: { h: ['${tag}'] }`)
    .join(", ")}, status: { h: [] } } },
}`;

// [LAW:no-ambient-temporal-coupling] Every rig a case builds is closed after
// it, whether the case passed or threw.
const rigs: Rig[] = [];
afterEach(() => rigs.splice(0).forEach((rig) => rig.dispose()));

const rigOf = (d: Domain) => {
  const rig = buildRig({
    source: sourceOf(d),
    base: DEFAULT_DSL_CONFIG,
    sessionId: SID,
  });
  rigs.push(rig);
  const draw = (at: Instant): Frame =>
    rig.draw({ opts: { width: 400, wrap: true }, at }).frame;
  return { ...rig, draw };
};

// The option ring as the picker draws it: every option, in the domain's
// order, which holds while the picker draws its whole domain on one page.
const ringOf = (frame: Frame, key: string): string[] => {
  const links = linksOn(frame, "pk");
  if (
    links.some((l) => effectsOf(l.url).some((e) => e.verb === VERB_TURN_PAGE))
  )
    throw new Error(
      `the picker pages, so it draws part of the ring: ${textOf(frame)}`,
    );
  return links.flatMap((l) => writes(l.url, key) ?? []);
};

// [LAW:verifiable-goals] The option `by` steps round `ring` from `from`,
// worked out here apart from the ring the click lands through, so an arrow
// case checks that ring rather than repeating it.
const stepped = (ring: readonly string[], from: string, by: number): string => {
  const at = ring.indexOf(from);
  if (at === -1)
    throw new Error(`"${from}" is not on the ring ${ring.join(" ")}`);
  return ring[(((at + by) % ring.length) + ring.length) % ring.length]!;
};

// What each control marks as current, and what it marks while the bar wears
// `worn`, beside the frame's text so a failure shows the bar.
const marked = (frame: Frame, d: Domain) => ({
  drawn: textOf(frame),
  ...Object.fromEntries(
    d.controls.flatMap(({ tag, mark }) =>
      mark ? [[tag, mark.shown(frame, d.key)]] : [],
    ),
  ),
});
const marking = (frame: Frame, d: Domain, worn: string) => ({
  drawn: textOf(frame),
  ...Object.fromEntries(
    d.controls.flatMap(({ tag, mark }) =>
      mark ? [[tag, mark.wearing(frame, worn)]] : [],
    ),
  ),
});

describe.each(DOMAINS)("a $field chosen per draw by a rule", (d) => {
  test("every control marks the option the bar wears at each instant, in turn", () => {
    const rt = rigOf(d);
    const first = rt.draw(AT_02);
    // Every mark draws the two answers apart, so a control marking one can be
    // told from one marking the other.
    for (const { tag, mark } of d.controls)
      if (mark)
        expect([tag, mark.wearing(first, d.at02)]).not.toEqual([
          tag,
          mark.wearing(first, d.at03),
        ]);
    for (const [at, worn] of [
      [AT_02, d.at02],
      [AT_03, d.at03],
      [AT_02, d.at02],
      [AT_03, d.at03],
    ] as const) {
      const frame = rt.draw(at);
      expect(marked(frame, d)).toEqual(marking(frame, d, worn));
    }
  });

  const arrows = d.controls
    .filter((c) => c.arrows)
    .flatMap(({ tag }) => [
      { tag, glyph: CAROUSEL_NEXT, by: 1 },
      { tag, glyph: CAROUSEL_PREV, by: -1 },
    ]);

  test.each(arrows)(
    "$glyph on $tag, clicked 3 times with no redraw, lands 3 steps from the option its draw wore, and the pick then outranks the rule",
    async ({ tag, glyph, by }) => {
      const rt = rigOf(d);
      // The link carries the answer of the draw it was taken from: the draws
      // at the other answer before and after it do not move where it starts.
      rt.draw(AT_03);
      const frame = rt.draw(AT_02);
      const ring = ringOf(frame, d.key);
      const url = urlOn(frame, tag, glyph);
      rt.draw(AT_03);
      const landed: (string | null)[] = [];
      for (let i = 0; i < 3; i++) {
        await rt.click(url);
        landed.push(rt.sessionState.get(SID, d.key));
      }
      expect(landed).toEqual(
        [1, 2, 3].map((n) => stepped(ring, d.at02, n * by)),
      );
      for (const at of [AT_02, AT_03]) {
        const after = rt.draw(at);
        expect(marked(after, d)).toEqual(
          marking(after, d, stepped(ring, d.at02, 3 * by)),
        );
      }
    },
  );
});

describe.each(DOMAINS.filter((d) => d.controls.includes(SWATCHES)))(
  "a $field chosen per draw by a rule, its swatches row's ?",
  (d) => {
    test("lands an option other than the one its draw wore, where a random step from it lands at the click's instant", async () => {
      // A random step adds one offset to whichever centre it starts from, so at
      // one instant a step from the worn option and one from any other land
      // apart: the ring's own landing is what tells them apart.
      const at = instantOf(new Date(2026, 5, 4, 12, 0, 7));
      const rt = rigOf(d);
      rt.draw(AT_03);
      const frame = rt.draw(AT_02);
      await clickUrl(urlOn(frame, "sw", SWATCHES_RANDOM), {
        ...rt.ctx,
        now: () => at,
      });
      const landed = rt.sessionState.get(SID, d.key);
      expect(landed).not.toBe(d.at02);
      expect(landed).toBe(
        landing(ringOf(frame, d.key), d.at02, STEP_RANDOM, at),
      );
    });
  },
);
