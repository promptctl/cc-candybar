// [LAW:behavior-not-structure] A pure resolver: the wire hint wins over ambient state.

import { getTerminalWidth } from "../src/utils/terminal-width";

const RESERVE = 2;

describe("getTerminalWidth (post-kz8.4: pure, no-spawn)", () => {
  let savedColumns: string | undefined;
  let savedStderrDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    savedColumns = process.env.COLUMNS;
    savedStderrDescriptor = Object.getOwnPropertyDescriptor(
      process.stderr,
      "columns",
    );
    delete process.env.COLUMNS;
    Object.defineProperty(process.stderr, "columns", {
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
    if (savedStderrDescriptor) {
      Object.defineProperty(process.stderr, "columns", savedStderrDescriptor);
    } else {
      delete (process.stderr as { columns?: number }).columns;
    }
  });

  it("uses the explicit hint over ambient sources", () => {
    process.env.COLUMNS = "60";
    Object.defineProperty(process.stderr, "columns", {
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

  it("falls back to process.stderr.columns when env is absent", () => {
    // stdout is the captured statusline pipe; stderr stays attached to the terminal.
    Object.defineProperty(process.stderr, "columns", {
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
    expect(getTerminalWidth(2)).toBe(1);
    expect(getTerminalWidth(1)).toBe(1);
  });

  it("ignores malformed COLUMNS env values", () => {
    process.env.COLUMNS = "not-a-number";
    Object.defineProperty(process.stderr, "columns", {
      configurable: true,
      writable: true,
      value: 80,
    });
    expect(getTerminalWidth()).toBe(80 - RESERVE);
  });
});
