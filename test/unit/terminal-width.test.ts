// [LAW:behavior-not-structure] The one rule for the usable width of a Claude
// Code statusline row: the raw columns the client measured, less the gutter
// Claude Code prints each row inset by (its value is verified empirically in
// src/utils/terminal-width.ts). The raw width arrives as a hint on the wire,
// so nothing here reads the environment or a stream.

import { applyClaudeCodeReserve } from "../../src/utils/terminal-width";

const RESERVE = 2;

describe("applyClaudeCodeReserve", () => {
  it("takes the gutter off the raw width", () => {
    expect(applyClaudeCodeReserve(200)).toBe(200 - RESERVE);
    expect(applyClaudeCodeReserve(120)).toBe(120 - RESERVE);
  });

  it("clamps the reserved width to a minimum of 1", () => {
    // A raw width at or below the reserve would go non-positive; the floor
    // keeps it at 1 rather than 0/negative.
    expect(applyClaudeCodeReserve(2)).toBe(1);
    expect(applyClaudeCodeReserve(1)).toBe(1);
    expect(applyClaudeCodeReserve(0)).toBe(1);
  });
});
