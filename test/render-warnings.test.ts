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

const S = { config: {}, width: 80 };

describe("a renderer's warning record", () => {
  test("a record drawn from another config or width reads as none, never a stale count", () => {
    const records = new RenderWarningRecords();
    records.drawn("s", "request", S, [warning("a")]);
    expect(records.of("s", "request", { ...S, config: {} })).toEqual([]);
    expect(records.of("s", "request", { ...S, width: 100 })).toEqual([]);
    expect(records.of("s", "request", S)).toEqual([warning("a")]);
    // A new scope's first frame meeting the same warning is a move.
    expect(
      records.drawn("s", "request", { ...S, width: 100 }, [warning("a")]),
    ).toBe(true);
  });

  test("a warning that starts is recorded by the frame that met it, and cleared by the first frame without it", () => {
    const records = new RenderWarningRecords();
    expect(records.of("s", "request", S)).toEqual([]);
    expect(records.drawn("s", "request", S, [])).toBe(false);
    expect(records.drawn("s", "request", S, [warning("a")])).toBe(true);
    expect(records.of("s", "request", S)).toEqual([warning("a")]);
    expect(records.drawn("s", "request", S, [])).toBe(true);
    expect(records.of("s", "request", S)).toEqual([]);
  });

  test("the same warnings again, as new objects, leave the record unmoved", () => {
    const records = new RenderWarningRecords();
    records.drawn("s", "request", S, [warning("a"), warning("b")]);
    expect(records.drawn("s", "request", S, [warning("a"), warning("b")])).toBe(
      false,
    );
    expect(records.drawn("s", "request", S, [warning("a")])).toBe(true);
    expect(records.of("s", "request", S)).toEqual([warning("a")]);
  });

  test("each renderer and each session keeps its own", () => {
    const records = new RenderWarningRecords();
    records.drawn("s", "request", S, [warning("statusline")]);
    records.drawn("s", "feed", S, [warning("lane")]);
    records.drawn("t", "request", S, []);
    expect(records.of("s", "request", S)).toEqual([warning("statusline")]);
    expect(records.of("s", "feed", S)).toEqual([warning("lane")]);
    expect(records.of("t", "request", S)).toEqual([]);
  });

  test("bounded: the least recently drawn record goes first", () => {
    const records = new RenderWarningRecords(2);
    records.drawn("a", "request", S, [warning("a")]);
    records.drawn("b", "request", S, [warning("b")]);
    records.drawn("a", "request", S, [warning("a")]);
    records.drawn("c", "request", S, [warning("c")]);
    expect(records.of("b", "request", S)).toEqual([]);
    expect(records.of("a", "request", S)).toEqual([warning("a")]);
    expect(records.of("c", "request", S)).toEqual([warning("c")]);
  });
});
