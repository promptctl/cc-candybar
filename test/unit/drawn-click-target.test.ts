import { ColorSpec, RichText, Segment, Style } from "@promptctl/rich-js";
import { effectsUrl, VERB_COPY, VERB_SET_STATE } from "../../src/click/wire";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSE,
} from "../../src/config/disclosure";
import { parseClick } from "../../src/daemon/click-reading";
import { publishingFrames } from "../../src/daemon/foundations/frame-publication";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { disclosureCloseFragment } from "../../src/render/disclosure-close";
import { runLines } from "../../src/render/frame";
import { RENDER_THEME, resolvedStyle } from "../../src/render/rich-theme";
import { createCcCandybarEngine } from "../../src/template-engine/engine";
import { heldCell } from "../../src/template-engine/layout";
import { TEST_SIGNER } from "../helpers/link-signer";
import { TEST_ENGINE } from "../helpers/test-engine";

const SESSION = sessionIdOf("session");
const CLOSE = DISCLOSURE_GLYPH_CLOSE;
const KEY = "groups.details";
const ACTION = {
  kind: "action",
  effects: [{
    verb: VERB_SET_STATE,
    args: [SESSION, KEY, DISCLOSURE_CLOSED],
  }],
} as const;

function runs(fragments: readonly RichText[]) {
  const text = RichText.fromFragments(fragments);
  const segments = [...text.render({ maxWidth: 80, theme: RENDER_THEME })];
  return runLines([...Segment.simplify(segments)], null).flat();
}

const template = (source: string, scope: object) =>
  createCcCandybarEngine(TEST_ENGINE).parse(source).evaluate(scope);

test("adjacent equivalent close targets retain one action and a different key retains its own", () => {
  const control = disclosureCloseFragment(SESSION, KEY);
  const other = disclosureCloseFragment(SESSION, "groups.other");
  // Copies of an existing run body have no per-draw action lookup.
  expect(runs([control, control.copy(), other])).toEqual([
    { text: CLOSE + CLOSE, link: ACTION },
    {
      text: CLOSE,
      link: {
        kind: "action",
        effects: [{
          verb: VERB_SET_STATE,
          args: [SESSION, "groups.other", DISCLOSURE_CLOSED],
        }],
      },
    },
  ]);
  expect(
    runs(template('{{ bold (style "underline" .control) }}', { control })),
  ).toEqual([{ text: CLOSE, link: ACTION }]);
});

test("an authored href cannot acquire or resurrect the generated target", () => {
  const control = disclosureCloseFragment(SESSION, KEY);
  const marker = resolvedStyle(control.style).link;
  if (marker === undefined)
    throw new Error("test needs the carrier Style.link");
  const external = "https://example.test/page?query=%2B#section";
  const osc = `\u001b${marker}`;
  const scope = { control, marker, external, osc, spec: `bold link ${marker}` };

  for (const expression of [
    "{{ link .marker .control }}",
    "{{ link .marker (link .external .control) }}",
    "{{ link .marker (style .spec .control) }}",
    "{{ style .spec .control }}",
    "{{ link .osc .control }}",
  ]) {
    expect(runs([control, ...template(expression, scope)])).toEqual([
      { text: CLOSE, link: ACTION },
      { text: CLOSE, link: { kind: "href", url: marker } },
    ]);
  }
  expect(runs(template("{{ link .external .control }}", scope))).toEqual([
    { text: CLOSE, link: external },
  ]);
  expect(
    runs([new RichText(CLOSE, { style: new Style({ link: marker }) })]),
  ).toEqual([{ text: CLOSE }]);
});

test("named style overlays keep the original safe href and a held placement carries no target", () => {
  const ordinary = new RichText("external", { style: "bright_white" });
  const url = "https://example.test/%2B#x";
  expect(
    runs(template("{{ link .url .ordinary }}", { url, ordinary })),
  ).toEqual([{ text: "external", link: url }]);
  const control = disclosureCloseFragment(SESSION, KEY);
  const held = heldCell({
    text: control,
    placement: {
      id: "menu",
      effect: "none",
      ground: ColorSpec.parse("#000000").getTruecolor(),
    },
  });
  expect(runs([held.text])).toEqual([{ text: CLOSE }]);
});

test("the host signs the generated control and retains legacy authored click behavior", () => {
  const raw = effectsUrl(ACTION.effects);
  const control = disclosureCloseFragment(SESSION, KEY);
  const copy = "cc-candybar://copy/literal%20text";
  const authored = template('{{ link .copy "literal" }}', { copy });
  const frame = publishingFrames(TEST_SIGNER)({
    depth: "none",
    rows: [{ kind: "bar", runs: runs([control, ...authored]) }],
    nextChange: null,
    motion: "still",
    pending: [],
  });
  const signed = TEST_SIGNER.signLink(raw);
  expect(frame.rows[0]?.runs).toEqual([
    { text: CLOSE, link: signed },
    { text: "literal", link: TEST_SIGNER.signLink(copy) },
  ]);
  const delivery = { kind: "forwarder", urlV: 2 } as const;
  expect(parseClick(signed, delivery, TEST_SIGNER)).toMatchObject({
    kind: "link",
    click: {
      scope: "session",
      session: SESSION,
      steps: [
        {
          kind: "session",
          verb: VERB_SET_STATE,
          args: [KEY, DISCLOSURE_CLOSED],
        },
      ],
    },
  });
  expect(
    parseClick(TEST_SIGNER.signLink(copy), delivery, TEST_SIGNER),
  ).toMatchObject({
    kind: "link",
    click: {
      scope: "global",
      steps: [{ kind: "global", verb: VERB_COPY, value: "literal text" }],
    },
  });
});
