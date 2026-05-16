// [LAW:behavior-not-structure] These tests assert the post-kz8.4 contract:
// getTerminalWidth is a pure resolver — no subprocess, no shell-out. The hint
// from the wire boundary wins over ambient state; ambient state wins over
// nothing. The reserve for Claude Code's right-side UI applies uniformly.

import { getTerminalWidth } from "../src/utils/terminal-width";

const RESERVE = 45;

describe("getTerminalWidth (post-kz8.4: pure, no-spawn)", () => {
  let savedColumns: string | undefined;
  let savedStdoutColumns: number | undefined;

  beforeEach(() => {
    savedColumns = process.env.COLUMNS;
    savedStdoutColumns = process.stdout.columns;
    delete process.env.COLUMNS;
    // process.stdout.columns is read-only in some Node versions; cast to override
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    if (savedColumns === undefined) {
      delete process.env.COLUMNS;
    } else {
      process.env.COLUMNS = savedColumns;
    }
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      writable: true,
      value: savedStdoutColumns,
    });
  });

  it("uses the explicit hint over ambient sources", () => {
    process.env.COLUMNS = "60";
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      writable: true,
      value: 70,
    });
    expect(getTerminalWidth(200)).toBe(200 - RESERVE);
  });

  it("falls back to COLUMNS env when no hint is supplied", () => {
    process.env.COLUMNS = "120";
    expect(getTerminalWidth()).toBe(120 - RESERVE);
  });

  it("falls back to process.stdout.columns when env is absent", () => {
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      writable: true,
      value: 90,
    });
    expect(getTerminalWidth()).toBe(90 - RESERVE);
  });

  it("returns null when no source is available", () => {
    expect(getTerminalWidth()).toBeNull();
  });

  it("ignores non-positive hints and falls through", () => {
    process.env.COLUMNS = "100";
    expect(getTerminalWidth(0)).toBe(100 - RESERVE);
    expect(getTerminalWidth(-5)).toBe(100 - RESERVE);
  });

  it("clamps reserved width to a minimum of 1", () => {
    expect(getTerminalWidth(10)).toBe(1);
  });

  it("ignores malformed COLUMNS env values", () => {
    process.env.COLUMNS = "not-a-number";
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      writable: true,
      value: 80,
    });
    expect(getTerminalWidth()).toBe(80 - RESERVE);
  });
});
