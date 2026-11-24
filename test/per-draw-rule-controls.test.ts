// [LAW:verifiable-goals] A control that centres on a key's value, over a
// theme, style or effect a rule chooses PER DRAW (a rule reading `now`), shows
// the option the bar wears at the instant drawn, and its arrows step from that
// option: the picker marks it, and over a colour-valued domain the swatches
// row brackets it and the carousel label and the swatch of the option in force
// show its colours. The rule's answer exists only in a draw, so every rig is
// drawn at both instants: a reader that kept the first draw's answer, or the
// floor under the rule, shows here.

import { linksOf, effectsOf } from "../src/click/read";
import { VERB_SET_STATE } from "../src/click/wire";
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

interface Domain {
  readonly field: string;
  readonly key: string;
  readonly from: string | readonly string[];
  readonly at02: string;
  readonly at03: string;
  // A colour-valued domain draws a swatches row and the swatch of the option
  // in force; every domain draws a carousel and a picker.
  readonly colour: boolean;
}

const DOMAINS: readonly Domain[] = [
  {
    field: "palette",
    key: "theme",
    from: "themes",
    at02: "nord",
    at03: "dracula",
    colour: true,
  },
  {
    field: "style",
    key: "style",
    from: "styles",
    at02: "vivid",
    at03: "muted",
    colour: true,
  },
  {
    field: "effect",
    key: "effect",
    from: EFFECT_NAMES,
    at02: "pulse",
    at03: "sparkle",
    colour: false,
  },
];

// Each control on a row of its own, led by its tag, so a reading of one
// control reads that row alone: the bundled default draws glyphs of its own.
const controlsOf = ({ colour }: Domain): Readonly<Record<string, string>> => ({
  car: '{{ carousel "apply" "open" "Pick" }}',
  pk: '{{ picker "apply" "page" false true }}',
  ...(colour && {
    sw: '{{ swatches "apply" "page" }}',
    held: '{{ swatch "apply" }}',
  }),
});

const sourceOf = (d: Domain): string => {
  const controls = controlsOf(d);
  return `{
  globals: { ${d.field}: '${rule(d.at02, d.at03)}' },
  variables: { page: { kind: 'state', key: 'page', default: '0' } },
  actions: {
    apply: { set: '${d.key}', from: ${JSON.stringify(d.from)} },
    page: { set: 'page', int: true },
    open: { set: 'opened', to: 'yes' },
  },
  segments: ${JSON.stringify(
    Object.fromEntries(
      Object.entries(controls).map(([tag, t]) => [
        tag,
        { template: `${tag} ${t}` },
      ]),
    ),
  )},
  root: { rows: { ${Object.keys(controls)
    .map((tag) => `${tag}: { h: ['${tag}'] }`)
    .join(", ")}, status: { h: [] } } },
}`;
};

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

// The row the control `tag` leads. A row opens on its endcap, so
// the tag is found as a run of its own.
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

// The option ring as the picker draws it: every option, in the domain's order.
const ringOf = (frame: Frame, key: string): string[] =>
  linksOn(frame, "pk").flatMap((l) => writes(l.url, key) ?? []);

// [LAW:parse-dont-validate] The option `by` steps round `ring` from `from`, an
// option the ring holds.
const stepped = (ring: readonly string[], from: string, by: number): string => {
  const at = ring.indexOf(from);
  if (at === -1)
    throw new Error(`"${from}" is not on the ring ${ring.join(" ")}`);
  return ring[(((at + by) % ring.length) + ring.length) % ring.length]!;
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

// What each control shows as current, beside the frame's text so a failure
// shows the bar: the picker's bold options and the swatches row's bracketed
// swatch by the option they write, the carousel label's and the held swatch's
// colours as they are.
const shown = (frame: Frame, d: Domain) => {
  const bold = new Set(boldUrls({ rows: [rowOf(frame, "pk")] }));
  return {
    drawn: textOf(frame),
    picker: linksOn(frame, "pk").flatMap(
      (l) => (bold.has(l.url) && writes(l.url, d.key)) || [],
    ),
    ...(d.colour && {
      swatches: linksOn(frame, "sw").flatMap(
        (l) => (l.text === "[▀▀▀]" && writes(l.url, d.key)) || [],
      ),
      carousel: swatchAfter(frame, "car", "Pick"),
      held: swatchAfter(frame, "held", "held"),
    }),
  };
};

// What each control shows while the bar wears `worn`: the option itself, or
// the colours the picker draws beside it.
const showing = (frame: Frame, d: Domain, worn: string) => ({
  drawn: textOf(frame),
  picker: [worn],
  ...(d.colour && {
    swatches: [worn],
    carousel: swatchAfter(frame, "pk", worn),
    held: swatchAfter(frame, "pk", worn),
  }),
});

describe.each(DOMAINS)("a $field chosen per draw by a rule", (d) => {
  test("every control shows the option the bar wears at each instant, in turn", () => {
    const rt = rigOf(d);
    const first = rt.draw(AT_02);
    // The two answers draw apart, so a control showing one can be told from
    // one showing the other.
    if (d.colour)
      expect(swatchAfter(first, "pk", d.at02)).not.toBe(
        swatchAfter(first, "pk", d.at03),
      );
    for (const [at, worn] of [
      [AT_02, d.at02],
      [AT_03, d.at03],
      [AT_02, d.at02],
      [AT_03, d.at03],
    ] as const) {
      const frame = rt.draw(at);
      expect(shown(frame, d)).toEqual(showing(frame, d, worn));
    }
  });

  const arrows = (d.colour ? ["car", "sw"] : ["car"]).flatMap((tag) => [
    { tag, glyph: CAROUSEL_NEXT, by: 1 },
    { tag, glyph: CAROUSEL_PREV, by: -1 },
  ]);

  test.each(arrows)(
    "$glyph on $tag, clicked 3 times with no redraw, lands 3 steps from the option the draw wore, and the pick then outranks the rule",
    async ({ tag, glyph, by }) => {
      const rt = rigOf(d);
      // A draw at the other answer comes first and last: the link keeps
      // nothing of either.
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
        expect(shown(after, d)).toEqual(
          showing(after, d, stepped(ring, d.at02, 3 * by)),
        );
      }
    },
  );
});

describe.each(DOMAINS.filter((d) => d.colour))(
  "a $field chosen per draw by a rule, its swatches row's ?",
  (d) => {
    test("lands an option other than the one the draw wore, where a random step from it lands at the click's instant", async () => {
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
