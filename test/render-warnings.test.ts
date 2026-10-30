// [LAW:verifiable-goals] A renderer's warning record: every frame's warnings,
// compared by value, so a warning that starts or stops while nothing else
// about the frame moved is counted, or cleared, by the next frame; each
// renderer keeps its own.

import { RenderWarningRecords } from "../src/daemon/render-warnings";
import type { RenderWarning } from "../src/dsl/render";

const warning = (message: string): RenderWarning => ({
  kind: "band-floor",
  message,
});

describe("a renderer's warning record", () => {
  test("a warning that starts is recorded by the frame that met it, and cleared by the first frame without it", () => {
    const records = new RenderWarningRecords();
    expect(records.of("s", "request")).toEqual([]);
    expect(records.drawn("s", "request", [])).toBe(false);
    expect(records.drawn("s", "request", [warning("a")])).toBe(true);
    expect(records.of("s", "request")).toEqual([warning("a")]);
    expect(records.drawn("s", "request", [])).toBe(true);
    expect(records.of("s", "request")).toEqual([]);
  });

  test("the same warnings again, as new objects, leave the record unmoved", () => {
    const records = new RenderWarningRecords();
    records.drawn("s", "request", [warning("a"), warning("b")]);
    expect(records.drawn("s", "request", [warning("a"), warning("b")])).toBe(
      false,
    );
    expect(records.drawn("s", "request", [warning("a")])).toBe(true);
    expect(records.of("s", "request")).toEqual([warning("a")]);
  });

  test("each renderer and each session keeps its own", () => {
    const records = new RenderWarningRecords();
    records.drawn("s", "request", [warning("statusline")]);
    records.drawn("s", "feed", [warning("lane")]);
    records.drawn("t", "request", []);
    expect(records.of("s", "request")).toEqual([warning("statusline")]);
    expect(records.of("s", "feed")).toEqual([warning("lane")]);
    expect(records.of("t", "request")).toEqual([]);
  });

  test("bounded: the least recently drawn record goes first", () => {
    const records = new RenderWarningRecords(2);
    records.drawn("a", "request", [warning("a")]);
    records.drawn("b", "request", [warning("b")]);
    records.drawn("a", "request", [warning("a")]);
    records.drawn("c", "request", [warning("c")]);
    expect(records.of("b", "request")).toEqual([]);
    expect(records.of("a", "request")).toEqual([warning("a")]);
    expect(records.of("c", "request")).toEqual([warning("c")]);
  });
});
