// [LAW:verifiable-goals] candybar-isolated-daemon-bfab.dnr: what a reader takes
// from a Frame, with no bytes in between: its links, its text, and what stands
// in for it.

import { linksOf } from "../src/click/read";
import {
  composeBar,
  parseFrame,
  standIn,
  textOf,
  type Frame,
  type Row,
  type Run,
} from "../src/render/frame";

const A = "cc-candybar://dispatch/e=a";
const B = "https://example.invalid/b";
const row = (...runs: Run[]): Row => ({ kind: "bar", runs });
const frameOf = (...rows: Row[]): Frame => ({
  depth: "truecolor",
  rows,
  nextChange: Infinity,
  motion: "still",
  pending: [],
});

describe("linksOf", () => {
  test("neighbouring runs of one URI are one link, whatever each looks like", () => {
    expect(
      linksOf(
        frameOf(
          row(
            { text: "the", fg: "#ff0000", link: A },
            { text: "me", bg: "#00ff00", attrs: ["bold"], link: A },
          ),
        ),
      ),
    ).toEqual([{ text: "theme", url: A }]);
  });

  test("two URIs side by side are two links", () => {
    expect(
      linksOf(frameOf(row({ text: "a", link: A }, { text: "b", link: B }))),
    ).toEqual([
      { text: "a", url: A },
      { text: "b", url: B },
    ]);
  });

  test("something visible between two runs of one URI keeps them two", () => {
    expect(
      linksOf(
        frameOf(
          row({ text: "a", link: A }, { text: " " }, { text: "b", link: A }),
        ),
      ),
    ).toEqual([
      { text: "a", url: A },
      { text: "b", url: A },
    ]);
  });

  test("nothing visible between them joins them", () => {
    expect(
      linksOf(
        frameOf(
          row({ text: "a", link: A }, { text: "" }, { text: "b", link: A }),
        ),
      ),
    ).toEqual([{ text: "ab", url: A }]);
  });

  test("a link's text is trimmed", () => {
    expect(linksOf(frameOf(row({ text: " ▶ ", link: A })))).toEqual([
      { text: "▶", url: A },
    ]);
  });

  test("a link wrapped across rows is one link per row", () => {
    expect(
      linksOf(frameOf(row({ text: "a", link: A }), row({ text: "b", link: A }))),
    ).toEqual([
      { text: "a", url: A },
      { text: "b", url: A },
    ]);
  });

  test("a frame with no look keeps its links", () => {
    const bare: Frame = { ...frameOf(row({ text: "a", link: A })), depth: "none" };
    expect(linksOf(bare)).toEqual([{ text: "a", url: A }]);
  });
});

test("textOf is a frame's text, a line per row", () => {
  expect(
    textOf(
      frameOf(row({ text: "a", fg: "#ff0000" }, { text: "b" }), row({ text: "c" })),
    ),
  ).toBe("ab\nc");
});

test("composeBar ends the frame's last line", () => {
  expect(composeBar({ depth: "none", rows: [row({ text: "a" })] })).toBe("a\n");
});

test("parseFrame restores what JSON wrote as null, and keeps a moment", () => {
  const wire = JSON.parse(JSON.stringify(frameOf(row({ text: "a" })))) as Frame;
  expect(wire.nextChange).toBeNull();
  expect(parseFrame(wire).nextChange).toBe(Infinity);
  expect(parseFrame({ ...wire, nextChange: 12.5 }).nextChange).toBe(12.5);
  expect(parseFrame(frameOf()).nextChange).toBe(Infinity);
});

describe("standIn", () => {
  const rows = [row({ text: "in its place" })];
  const moving: Frame = {
    ...frameOf(row({ text: "the bar" })),
    depth: "ansi",
    nextChange: 12.5,
    motion: "moves",
    pending: ["git"],
  };

  test("is still text at the frame's depth, and draws none of its sources", () => {
    expect(standIn(moving, rows)).toEqual({
      depth: "ansi",
      rows,
      nextChange: Infinity,
      motion: "can-move",
      pending: [],
    });
  });

  test("a bar that can move again stays able to, and a still one stays still", () => {
    expect(standIn({ ...moving, motion: "can-move" }, rows).motion).toBe(
      "can-move",
    );
    expect(standIn({ ...moving, motion: "still" }, rows).motion).toBe("still");
  });
});
