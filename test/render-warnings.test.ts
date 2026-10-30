// [LAW:verifiable-goals] A renderer's warning record: every frame's warnings,
// compared by value, so a warning that starts or stops while nothing else
// about the frame moved is counted, or cleared, by the next frame; each
// renderer keeps its own.

import { RenderWarningRecords } from "../src/daemon/render-warnings";
import type { RenderWarning } from "../src/dsl/render";

const warning = (message: string): RenderWarning => ({
  kind: "refresh",
  variable: message,
  error: message,
  message,
});

const S = { config: {} };

describe("a renderer's warning record", () => {
  test("a renderer's own record holds across a reload or resize until its next frame replaces it", () => {
    const records = new RenderWarningRecords();
    records.drawn("s", "request", S, [warning("a")]);
    // A warning still met never looks gone for a frame, so an open viewer
    // on it neither closes nor reopens.
    expect(records.ofSession("s", "request", { config: {} })).toEqual([
      warning("a"),
    ]);
    expect(records.drawn("s", "request", { config: {} }, [warning("a")])).toBe(
      false,
    );
  });

  test("a warning that starts is recorded by the frame that met it, and cleared by the first frame without it", () => {
    const records = new RenderWarningRecords();
    expect(records.of("s", "request")).toEqual([]);
    expect(records.drawn("s", "request", S, [])).toBe(false);
    expect(records.drawn("s", "request", S, [warning("a")])).toBe(true);
    expect(records.of("s", "request")).toEqual([warning("a")]);
    expect(records.drawn("s", "request", S, [])).toBe(true);
    expect(records.of("s", "request")).toEqual([]);
  });

  test("the same warnings again, as new objects, leave the record unmoved", () => {
    const records = new RenderWarningRecords();
    records.drawn("s", "request", S, [warning("a"), warning("b")]);
    expect(records.drawn("s", "request", S, [warning("a"), warning("b")])).toBe(
      false,
    );
    expect(records.drawn("s", "request", S, [warning("a")])).toBe(true);
    expect(records.of("s", "request")).toEqual([warning("a")]);
  });

  test("each renderer and each session keeps its own", () => {
    const records = new RenderWarningRecords();
    records.drawn("s", "request", S, [warning("statusline")]);
    records.drawn("s", "feed", S, [warning("lane")]);
    records.drawn("t", "request", S, []);
    expect(records.of("s", "request")).toEqual([warning("statusline")]);
    expect(records.of("s", "feed")).toEqual([warning("lane")]);
    expect(records.of("t", "request")).toEqual([]);
  });

  test("bounded: the least recently drawn record goes first", () => {
    const records = new RenderWarningRecords(2);
    records.drawn("a", "request", S, [warning("a")]);
    records.drawn("b", "request", S, [warning("b")]);
    records.drawn("a", "request", S, [warning("a")]);
    records.drawn("c", "request", S, [warning("c")]);
    expect(records.of("b", "request")).toEqual([]);
    expect(records.of("a", "request")).toEqual([warning("a")]);
    expect(records.of("c", "request")).toEqual([warning("c")]);
  });

  test("the session's list is every renderer's, the same on each surface, a shared warning once", () => {
    const records = new RenderWarningRecords();
    const lane = S;
    records.drawn("s", "request", S, [warning("both"), warning("statusline")]);
    records.drawn("s", "feed", lane, [warning("lane"), warning("both")]);
    const expected = [warning("both"), warning("statusline"), warning("lane")];
    expect(records.ofSession("s", "request", S)).toEqual(expected);
    expect(records.ofSession("s", "feed", lane)).toEqual(expected);
    // Another renderer's record from a retired config is not counted.
    expect(records.ofSession("s", "request", { config: {} })).toEqual([
      warning("both"),
      warning("statusline"),
    ]);
  });
});
