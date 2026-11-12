// [LAW:verifiable-goals] A renderer's warning record: every frame's warnings,
// compared by value, so a warning that starts or stops while nothing else
// about the frame moved is counted, or cleared, by the next frame; each
// renderer keeps its own.

import { RenderWarningRecords } from "../../src/daemon/render-warnings";
import type { RenderWarning } from "../../src/dsl/render";
import { sessionIdOf } from "../../src/daemon/session-id";

const S_2 = sessionIdOf("s");
const T = sessionIdOf("t");
const A_2 = sessionIdOf("a");
const B = sessionIdOf("b");
const C = sessionIdOf("c");

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
    records.drawn(S_2, "request", S, [warning("a")]);
    // A warning still met never looks gone for a frame, so an open viewer
    // on it neither closes nor reopens.
    expect(records.ofSession(S_2, "request", { config: {} })).toEqual([
      warning("a"),
    ]);
    expect(records.drawn(S_2, "request", { config: {} }, [warning("a")])).toBe(
      false,
    );
  });

  test("a warning that starts is recorded by the frame that met it, and cleared by the first frame without it", () => {
    const records = new RenderWarningRecords();
    expect(records.of(S_2, "request")).toEqual([]);
    expect(records.drawn(S_2, "request", S, [])).toBe(false);
    expect(records.drawn(S_2, "request", S, [warning("a")])).toBe(true);
    expect(records.of(S_2, "request")).toEqual([warning("a")]);
    expect(records.drawn(S_2, "request", S, [])).toBe(true);
    expect(records.of(S_2, "request")).toEqual([]);
  });

  test("the same warnings again, as new objects, leave the record unmoved", () => {
    const records = new RenderWarningRecords();
    records.drawn(S_2, "request", S, [warning("a"), warning("b")]);
    expect(records.drawn(S_2, "request", S, [warning("a"), warning("b")])).toBe(
      false,
    );
    expect(records.drawn(S_2, "request", S, [warning("a")])).toBe(true);
    expect(records.of(S_2, "request")).toEqual([warning("a")]);
  });

  test("each renderer and each session keeps its own", () => {
    const records = new RenderWarningRecords();
    records.drawn(S_2, "request", S, [warning("statusline")]);
    records.drawn(S_2, "feed", S, [warning("lane")]);
    records.drawn(T, "request", S, []);
    expect(records.of(S_2, "request")).toEqual([warning("statusline")]);
    expect(records.of(S_2, "feed")).toEqual([warning("lane")]);
    expect(records.of(T, "request")).toEqual([]);
  });

  test("bounded: the least recently drawn record goes first", () => {
    const records = new RenderWarningRecords(2);
    records.drawn(A_2, "request", S, [warning("a")]);
    records.drawn(B, "request", S, [warning("b")]);
    records.drawn(A_2, "request", S, [warning("a")]);
    records.drawn(C, "request", S, [warning("c")]);
    expect(records.of(B, "request")).toEqual([]);
    expect(records.of(A_2, "request")).toEqual([warning("a")]);
    expect(records.of(C, "request")).toEqual([warning("c")]);
  });

  test("the session's list is every renderer's, the same on each surface, a shared warning once", () => {
    const records = new RenderWarningRecords();
    const lane = S;
    records.drawn(S_2, "request", S, [warning("both"), warning("statusline")]);
    records.drawn(S_2, "feed", lane, [warning("lane"), warning("both")]);
    const expected = [warning("both"), warning("statusline"), warning("lane")];
    expect(records.ofSession(S_2, "request", S)).toEqual(expected);
    expect(records.ofSession(S_2, "feed", lane)).toEqual(expected);
    // Another renderer's record from a retired config is not counted.
    expect(records.ofSession(S_2, "request", { config: {} })).toEqual([
      warning("both"),
      warning("statusline"),
    ]);
  });
});
