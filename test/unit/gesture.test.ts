// A gesture's one spelling (src/click/gesture.ts) and how the bar pane's
// terminal reports one (src/bar-pane/mouse.ts).

import {
  ALL_GESTURES,
  gestureName,
  parseDelivered,
  parseGesture,
} from "../../src/click/gesture";
import { MOUSE_OFF, MOUSE_ON, readMouse } from "../../src/bar-pane/mouse";
import { deliveredIn } from "../../src/bar-pane/pointer";

describe("what a surface delivers", () => {
  it("is every button with each subset of the modifiers, once, in canonical spelling", () => {
    expect(ALL_GESTURES).toHaveLength(24);
    expect(new Set(ALL_GESTURES).size).toBe(24);
    expect(ALL_GESTURES).toEqual(
      expect.arrayContaining(["left", "ctrl+alt+shift+right", "alt+middle"]),
    );
    for (const name of ALL_GESTURES) {
      const gesture = parseGesture(name);
      expect(gesture.kind === "ok" && gestureName(gesture.value)).toBe(name);
    }
  });

  it("reads gestures and hover, spelled any way round, once each", () => {
    expect(
      parseDelivered(["hover", "shift+ctrl+left", "ctrl+shift+left", "left"]),
    ).toEqual({ kind: "ok", value: ["hover", "ctrl+shift+left", "left"] });
  });

  it("refuses an entry that is neither, naming it", () => {
    expect(parseDelivered(["left", "hold"])).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining('"hold" is not a gesture'),
    });
    expect(parseDelivered([3])).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("a string"),
    });
  });

  it("follows tmux's mouse option: every gesture and hover while it is on, the plain click while off", () => {
    // tmux's `#{mouse}` after the daemon's six fields, on the pane's own line.
    const listed = (own: string, mouse: string): string =>
      `%3 $1 1 1 0 1 1\n${own} $1 1 1 0 0 ${mouse}\n`;
    expect(deliveredIn(listed("%4", "1"), "%4")).toEqual([
      ...ALL_GESTURES,
      "hover",
    ]);
    expect(deliveredIn(listed("%4", "0"), "%4")).toEqual(["left"]);
    expect(deliveredIn("", "%4")).toEqual(["left"]);
  });
});

describe("gesture spelling", () => {
  it("reads any order of modifiers and names them in the one order", () => {
    for (const spelling of ["shift+ctrl+right", "ctrl+shift+right"]) {
      const parsed = parseGesture(spelling);
      if (parsed.kind !== "ok") throw new Error(parsed.reason);
      expect(gestureName(parsed.value)).toBe("ctrl+shift+right");
    }
  });

  it.each([
    ["", "ends in a button"],
    ["wheel", "ends in a button"],
    ["super+left", '"super" is not a modifier'],
    ["alt+alt+left", "names alt twice"],
    ["left+alt", "ends in a button"],
    ["left+left", '"left" is not a modifier'],
  ])("refuses %j and says why", (spelling, why) => {
    const parsed = parseGesture(spelling);
    expect(parsed).toEqual({
      kind: "failed",
      reason: expect.stringContaining(why),
    });
  });
});

const report = (code: number, column: number, row: number, final = "M") =>
  `\x1b[<${code};${column};${row}${final}`;

describe("mouse reports", () => {
  it("turns the modes on and off as a pair, 1006 outermost", () => {
    expect(MOUSE_ON).toBe("\x1b[?1000h\x1b[?1003h\x1b[?1006h");
    expect(MOUSE_OFF).toBe("\x1b[?1006l\x1b[?1003l\x1b[?1000l");
  });

  it("reads a button and its modifiers as a gesture", () => {
    const { events } = readMouse(
      report(0, 4, 1) + report(2, 5, 1) + report(1 + 16 + 8, 6, 2),
    );
    expect(
      events.map((e) =>
        e.kind === "press" ? [gestureName(e.gesture), e.at] : e.kind,
      ),
    ).toEqual([
      ["left", { column: 4, row: 1 }],
      ["right", { column: 5, row: 1 }],
      ["ctrl+alt+middle", { column: 6, row: 2 }],
    ]);
  });

  it("reads motion with no button, and a drag, as motion; a release as none", () => {
    const { events } = readMouse(
      report(35, 9, 1) + report(32, 10, 1) + report(0, 10, 1, "m"),
    );
    expect(events.map((e) => e.kind)).toEqual(["motion", "motion", "release"]);
  });

  it("reads the wheel as a wheel, never a press", () => {
    expect(readMouse(report(64, 1, 1)).events.map((e) => e.kind)).toEqual([
      "wheel",
    ]);
  });

  it("keeps the start of a report that has not all arrived", () => {
    const first = readMouse(`${report(0, 1, 1)}\x1b[<0;2`);
    expect(first.events).toHaveLength(1);
    expect(first.rest).toBe("\x1b[<0;2");
    const second = readMouse(`${first.rest};1M`);
    expect(second.events.map((e) => e.kind)).toEqual(["press"]);
    expect(second.rest).toBe("");
  });

  it("drops what the mouse did not send, keys included", () => {
    expect(readMouse("abc\x1b[A")).toEqual({ events: [], rest: "" });
    expect(readMouse(`q${report(0, 1, 1)}z`).events).toHaveLength(1);
  });
});
