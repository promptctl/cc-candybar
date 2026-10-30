// [LAW:verifiable-goals] A renderer's warning record: written by the first
// frame of a source and only then, so the count a later frame shows cannot
// move with that frame's own indicator; each renderer keeps its own.

import { RenderWarningRecords } from "../src/daemon/render-warnings";
import type { FrameSource } from "../src/render/frame-memory";
import type { RenderWarning } from "../src/dsl/render";

const CONFIG = {};
const source = (revision: number, width = 80): FrameSource => ({
  config: CONFIG,
  preset: "default",
  revision,
  width,
});
const warning = (message: string): RenderWarning => ({
  kind: "band-floor",
  message,
});

describe("a renderer's warning record", () => {
  test("a source's first frame records; later frames of it keep the record, whatever they met", () => {
    const records = new RenderWarningRecords();
    expect(records.of("s", "request")).toEqual([]);
    expect(records.drawn("s", "request", source(1), [warning("a")])).toBe(true);
    // A later frame of the same source met something else: the record holds.
    expect(records.drawn("s", "request", source(1), [])).toBe(false);
    expect(
      records.drawn("s", "request", source(1), [warning("a"), warning("b")]),
    ).toBe(false);
    expect(records.of("s", "request")).toEqual([warning("a")]);
  });

  test("a new source — a state write, a resize — records anew", () => {
    const records = new RenderWarningRecords();
    records.drawn("s", "request", source(1), [warning("a")]);
    expect(records.drawn("s", "request", source(2), [])).toBe(true);
    expect(records.of("s", "request")).toEqual([]);
    expect(
      records.drawn("s", "request", source(2, 40), [warning("narrow")]),
    ).toBe(true);
    expect(records.of("s", "request")).toEqual([warning("narrow")]);
  });

  test("each renderer and each session keeps its own", () => {
    const records = new RenderWarningRecords();
    records.drawn("s", "request", source(1), [warning("statusline")]);
    records.drawn("s", "feed", source(1, 120), [warning("lane")]);
    records.drawn("t", "request", source(1), []);
    expect(records.of("s", "request")).toEqual([warning("statusline")]);
    expect(records.of("s", "feed")).toEqual([warning("lane")]);
    expect(records.of("t", "request")).toEqual([]);
  });

  test("bounded: the least recently drawn record goes first", () => {
    const records = new RenderWarningRecords(2);
    records.drawn("a", "request", source(1), [warning("a")]);
    records.drawn("b", "request", source(1), [warning("b")]);
    records.drawn("a", "request", source(1), [warning("a")]);
    records.drawn("c", "request", source(1), [warning("c")]);
    expect(records.of("b", "request")).toEqual([]);
    expect(records.of("a", "request")).toEqual([warning("a")]);
    expect(records.of("c", "request")).toEqual([warning("c")]);
  });
});
