// [LAW:verifiable-goals] candybar-isolated-daemon-bfab.dnr: what a reader takes
// from a Frame, with no bytes in between: its links, its text, and what stands
// in for it.

import { describeLink, drawnClickOf, linksOf } from "../src/click/read";
import { effectsUrl, VERB_TOOLBAR_TOGGLE } from "../src/click/wire";
import { MAIN_NAME } from "../src/daemon/home";
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

describe("describeLink", () => {
  // A config can compute a link at the draw that the daemon refuses; a reader
  // shows the refusal, which is what its click does, rather than failing.
  test("a drawn link the daemon refuses reads as its refusal", () => {
    expect(drawnClickOf("cc-candybar://hello")).toEqual({
      ok: false,
      problem: expect.stringMatching(/the bare copy form/),
    });
    expect(describeLink({ text: "x", url: "cc-candybar://copy/x" }, "s")).toMatch(
      /^refused: the link is in the direct verb form .*, which names no renderer: cc-candybar:\/\/copy\/x$/,
    );
  });

  test("a drawn link whose value carries a malformed escape reads as its refusal", () => {
    expect(
      describeLink({ text: "x", url: "cc-candybar://to/main/dispatch/e=toolbar-toggle%2F100%25" }, "s"),
    ).toMatch(/^refused: the link's value does not decode .*: cc-candybar:\/\/to\/main\/dispatch\/e=toolbar-toggle%2F100%25$/);
  });

  // A frame an older daemon drew can name a verb this one retired; its click
  // is refused, so it reads as refused, never as the act it once was.
  test("a link naming a verb the daemon has not reads as its refusal", () => {
    const dispatched = `cc-candybar://to/main/dispatch/does=copy&e=${encodeURIComponent("copy/s")}`;
    expect(describeLink({ text: "x", url: dispatched }, "s")).toBe(
      `refused: the daemon has no verb "copy": ${dispatched}`,
    );
    // Its value is never read, so a malformed escape in it is not the reason.
    const malformed = `cc-candybar://to/main/dispatch/e=${encodeURIComponent("copy/100%")}`;
    expect(describeLink({ text: "x", url: malformed }, "s")).toBe(
      `refused: the daemon has no verb "copy": ${malformed}`,
    );
  });

  // A drawn link names dispatch, and a leaf verb is only ever its effect: a
  // link naming one itself is a click the daemon refuses.
  test("a link naming a verb itself, not through dispatch, reads as its refusal", () => {
    expect(describeLink({ text: "x", url: "cc-candybar://to/main/toolbar-toggle/s" }, "s")).toBe(
      'refused: a drawn link names dispatch, and this names "toolbar-toggle": cc-candybar://to/main/toolbar-toggle/s',
    );
  });

  test("an addressed link reads as its effects, and an outside link as opened", () => {
    expect(
      describeLink({ text: "x", url: effectsUrl(MAIN_NAME, [{ verb: VERB_TOOLBAR_TOGGLE, args: ["s"] }]) }, "s"),
    ).toBe("toolbar-toggle <session>");
    expect(describeLink({ text: "x", url: B }, "s")).toBe(`opens ${B}`);
  });
});
