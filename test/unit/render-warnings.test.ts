// [LAW:verifiable-goals] A renderer's warning record: every frame's warnings,
// compared by value, so a warning that starts or stops while nothing else
// about the frame moved is counted, or cleared, by the next frame; each
// renderer keeps its own.

import {
  RenderWarningRecords,
  type RecordScope,
} from "../../src/renderer/render-warnings";
import type { RenderWarning } from "../../src/dsl/render";
import {
  sessionIdOf,
  type SessionId,
} from "../../src/daemon/foundations/session-id";

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

// A frame's warnings as the turn that drew it records them: whether they move
// the record, then kept.
const drawn = (
  records: RenderWarningRecords,
  session: SessionId,
  by: "request" | "feed",
  scope: RecordScope,
  warnings: readonly RenderWarning[],
): boolean => {
  const moved = records.moves(session, by, warnings);
  records.keep(session, by, scope, warnings);
  return moved;
};

describe("a renderer's warning record", () => {
  test("a renderer's own record holds across a reload or resize until its next frame replaces it", () => {
    const records = new RenderWarningRecords();
    drawn(records, S_2, "request", S, [warning("a")]);
    // A warning still met never looks gone for a frame, so an open viewer
    // on it neither closes nor reopens.
    expect(records.ofSession(S_2, "request", { config: {} })).toEqual([
      warning("a"),
    ]);
    expect(drawn(records, S_2, "request", { config: {} }, [warning("a")])).toBe(
      false,
    );
  });

  test("a warning that starts is recorded by the frame that met it, and cleared by the first frame without it", () => {
    const records = new RenderWarningRecords();
    expect(records.of(S_2, "request")).toEqual([]);
    expect(drawn(records, S_2, "request", S, [])).toBe(false);
    expect(drawn(records, S_2, "request", S, [warning("a")])).toBe(true);
    expect(records.of(S_2, "request")).toEqual([warning("a")]);
    expect(drawn(records, S_2, "request", S, [])).toBe(true);
    expect(records.of(S_2, "request")).toEqual([]);
  });

  test("the same warnings again, as new objects, leave the record unmoved", () => {
    const records = new RenderWarningRecords();
    drawn(records, S_2, "request", S, [warning("a"), warning("b")]);
    expect(drawn(records, S_2, "request", S, [warning("a"), warning("b")])).toBe(
      false,
    );
    expect(drawn(records, S_2, "request", S, [warning("a")])).toBe(true);
    expect(records.of(S_2, "request")).toEqual([warning("a")]);
  });

  test("each renderer and each session keeps its own", () => {
    const records = new RenderWarningRecords();
    drawn(records, S_2, "request", S, [warning("statusline")]);
    drawn(records, S_2, "feed", S, [warning("lane")]);
    drawn(records, T, "request", S, []);
    expect(records.of(S_2, "request")).toEqual([warning("statusline")]);
    expect(records.of(S_2, "feed")).toEqual([warning("lane")]);
    expect(records.of(T, "request")).toEqual([]);
  });

  test("a retired session's records go on every renderer, and another's stay", () => {
    const records = new RenderWarningRecords();
    drawn(records, S_2, "request", S, [warning("statusline")]);
    drawn(records, S_2, "feed", S, [warning("lane")]);
    drawn(records, T, "request", S, [warning("other")]);
    records.retire(S_2);
    expect(records.of(S_2, "request")).toEqual([]);
    expect(records.of(S_2, "feed")).toEqual([]);
    expect(records.of(T, "request")).toEqual([warning("other")]);
  });

  test("bounded: the least recently drawn record goes first", () => {
    const records = new RenderWarningRecords(2);
    drawn(records, A_2, "request", S, [warning("a")]);
    drawn(records, B, "request", S, [warning("b")]);
    drawn(records, A_2, "request", S, [warning("a")]);
    drawn(records, C, "request", S, [warning("c")]);
    expect(records.of(B, "request")).toEqual([]);
    expect(records.of(A_2, "request")).toEqual([warning("a")]);
    expect(records.of(C, "request")).toEqual([warning("c")]);
  });

  test("the session's list is every renderer's, the same on each surface, a shared warning once", () => {
    const records = new RenderWarningRecords();
    const lane = S;
    drawn(records, S_2, "request", S, [warning("both"), warning("statusline")]);
    drawn(records, S_2, "feed", lane, [warning("lane"), warning("both")]);
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
