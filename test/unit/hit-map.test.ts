// Where a pointer can act on a published frame, and the link the bar pane finds
// there (src/render/hit-map.ts, src/bar-pane/hit-test.ts). Every link is signed
// by the host's one signer, so the pane can only find one, never make one.

import { parseGesture } from "../../src/click/gesture";
import { actionAt, linkPressed, touchOf } from "../../src/bar-pane/hit-test";
import { lineAtRow, paintedLines } from "../../src/bar-pane/paint";
import { publishingFrames } from "../../src/daemon/foundations/frame-publication";
import { effectsUrl, VERB_COPY } from "../../src/click/wire";
import type { Frame, Run } from "../../src/render/frame";
import { actionTarget } from "../../src/render/drawn-link";
import { hitMapOf } from "../../src/render/hit-map";
import { transitForm } from "../../src/click/link-signer";
import { TEST_SIGNER } from "../helpers/link-signer";

const copy = (text: string) => [{ verb: VERB_COPY, args: [text] }] as const;

const frameOf = (...rows: Run[][]): Frame => ({
  depth: "truecolor",
  rows: rows.map((runs) => ({ kind: "bar", runs })),
  nextChange: Infinity,
  motion: "still",
  pending: [],
});

const published = (...rows: Run[][]) =>
  publishingFrames(TEST_SIGNER)(frameOf(...rows));

// What a published link opens, once the host's signer has read it.
const openedAs = (link: string): string => {
  const opened = TEST_SIGNER.openLink(link);
  if (opened.kind !== "ok") throw new Error(opened.reason);
  return opened.value.href;
};
const hrefOf = (text: string): string => transitForm(effectsUrl(copy(text)));

const gesture = (spelling: string) => {
  const parsed = parseGesture(spelling);
  if (parsed.kind !== "ok") throw new Error(parsed.reason);
  return parsed.value;
};

const region = actionTarget(copy("left"), undefined, {
  name: "copyIt",
  gestures: { right: copy("right"), "ctrl+left": copy("ctrl-left") },
});

describe("the hit map of a published frame", () => {
  it("covers a region's cells once, however many runs the layout split it into", () => {
    const sent = published([
      { text: "ab" },
      { text: "c", link: region },
      { text: "d", link: region, fg: "#fff" },
      { text: "ef" },
    ]);
    expect(
      hitMapOf(sent).map((line) => line.map((h) => [h.from, h.to])),
    ).toEqual([[[2, 4]]]);
  });

  it("measures a run by its cells, so a wide glyph moves what follows it", () => {
    const sent = published([
      { text: "🍫" },
      { text: "go", link: actionTarget(copy("x")) },
    ]);
    expect(hitMapOf(sent)[0]!.map((h) => [h.from, h.to])).toEqual([[2, 4]]);
  });

  it("holds one signed link per gesture, the run's own link being the plain click", () => {
    const [hit] = hitMapOf(published([{ text: "go", link: region }]))[0]!;
    expect(Object.keys(hit!.links).sort()).toEqual([
      "ctrl+left",
      "left",
      "right",
    ]);
    expect(hit!.action).toBe("copyIt");
    for (const [name, text] of [
      ["left", "left"],
      ["right", "right"],
      ["ctrl+left", "ctrl-left"],
    ] as const)
      expect(openedAs(hit!.links[name]!)).toBe(hrefOf(text));
  });

  it("leaves out a link of another scheme, which belongs to the terminal", () => {
    const sent = published([
      { text: "pr", link: "https://example.test/pull/1" },
    ]);
    expect(hitMapOf(sent)).toEqual([[]]);
  });

  it("names no action for a region drawn from effects alone", () => {
    const [hit] = hitMapOf(
      published([{ text: "go", link: actionTarget(copy("x")) }]),
    )[0]!;
    expect(hit!.action).toBeNull();
    expect(Object.keys(hit!.links)).toEqual(["left"]);
  });
});

describe("what a press finds", () => {
  const hits = hitMapOf(
    published(
      [{ text: "..." }, { text: "go", link: region }],
      [{ text: "x", link: actionTarget(copy("below")) }],
    ),
  );

  it("is the link signed for the gesture, on a cell the region covers", () => {
    const at = { column: 4, row: 1 };
    expect(openedAs(linkPressed(hits, 2, at, gesture("right"))!)).toBe(
      hrefOf("right"),
    );
    expect(openedAs(linkPressed(hits, 2, at, gesture("left"))!)).toBe(
      hrefOf("left"),
    );
  });

  it("is nothing for a gesture the region does not bind, or a cell it does not cover", () => {
    expect(
      linkPressed(hits, 2, { column: 4, row: 1 }, gesture("alt+right")),
    ).toBe(undefined);
    expect(linkPressed(hits, 2, { column: 3, row: 1 }, gesture("left"))).toBe(
      undefined,
    );
    expect(linkPressed(hits, 2, { column: 6, row: 1 }, gesture("left"))).toBe(
      undefined,
    );
    expect(linkPressed(hits, 2, { column: 1, row: 9 }, gesture("left"))).toBe(
      undefined,
    );
  });

  it("is hovering the action a region names, and nothing over a cell with no region or a region with no action", () => {
    expect(actionAt(hits, 2, { column: 4, row: 1 })).toBe("copyIt");
    expect(actionAt(hits, 2, { column: 1, row: 1 })).toBeNull();
    expect(actionAt(hits, 2, { column: 1, row: 2 })).toBeNull();
    expect(actionAt(hits, 2, { column: 1, row: 9 })).toBeNull();
  });

  // paint writes line i at row i + 1, and the rows past a short pane's bottom
  // land on its last row.
  it("lands on the line the pane shows on that row, in a pane shorter than the frame", () => {
    expect(lineAtRow(1, 2, 2)).toBe(0);
    expect(lineAtRow(2, 2, 2)).toBe(1);
    expect(lineAtRow(3, 2, 2)).toBeNull();
    expect(lineAtRow(1, 1, 2)).toBe(1);
    expect(lineAtRow(2, 3, 5)).toBe(1);
    expect(lineAtRow(3, 3, 5)).toBe(4);
    expect(
      openedAs(linkPressed(hits, 1, { column: 1, row: 1 }, gesture("left"))!),
    ).toBe(hrefOf("below"));
  });

  // A frame's blank last lines are not painted, so the pane is as tall as the
  // lines it shows, and the hit map is cut to them: the row the last painted
  // line is on is not mistaken for a blank line below it.
  it("finds the last painted line when the frame ends in blank ones", () => {
    const cut = hitMapOf(
      published([{ text: "a" }], [{ text: "b", link: region }], [{ text: "" }]),
    ).slice(0, paintedLines("a\nb\n\n").length);
    expect(cut).toHaveLength(2);
    expect(actionAt(cut, 2, { column: 1, row: 2 })).toBe("copyIt");
  });

  describe("one report, decoded", () => {
    const at = { column: 4, row: 1 };

    it("is a press: the hover it lands on and the link it opens", () => {
      const touch = touchOf(hits, 2, {
        kind: "press",
        gesture: gesture("right"),
        at,
      });
      expect(touch?.hover).toBe("copyIt");
      expect(openedAs(touch!.press!.link!)).toBe(hrefOf("right"));
    });

    it("is motion: the hover alone, and no press", () => {
      expect(touchOf(hits, 2, { kind: "motion", at })).toEqual({
        hover: "copyIt",
        press: null,
      });
    });

    it("is a press on a cell with no link: a press with nothing to open", () => {
      expect(
        touchOf(hits, 2, {
          kind: "press",
          gesture: gesture("left"),
          at: { column: 1, row: 1 },
        }),
      ).toEqual({ hover: null, press: { link: undefined } });
    });

    it("asks nothing of a release or a wheel turn", () => {
      expect(touchOf(hits, 2, { kind: "release", at })).toBeNull();
      expect(touchOf(hits, 2, { kind: "wheel", at })).toBeNull();
    });
  });
});
