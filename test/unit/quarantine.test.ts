import { createRequire } from "node:module";

const quarantine = createRequire(__filename)("../helpers/quarantine.cjs");

const line = "2026-11-02 candybar-testing-ihvy.hcl test/a.test.ts › outer › the case";

describe("the quarantine list", () => {
  it("reads a line as the day it was listed, its ticket, its file and its case", () => {
    expect(quarantine.parseQuarantine(`# a comment\n\n${line}\n`)).toEqual([
      {
        date: "2026-11-02",
        addedAt: Date.UTC(2026, 10, 2),
        ticket: "candybar-testing-ihvy.hcl",
        file: "test/a.test.ts",
        name: "outer › the case",
      },
    ]);
  });

  it("finds a case by its file and its whole name", () => {
    const entries = quarantine.parseQuarantine(line);
    expect(quarantine.quarantined(entries, "test/a.test.ts", "outer › the case")).toBe(entries[0]);
    expect(quarantine.quarantined(entries, "test/a.test.ts", "the case")).toBeUndefined();
    expect(quarantine.quarantined(entries, "test/b.test.ts", "outer › the case")).toBeUndefined();
  });

  it.each([
    ["a line with no ticket", "2026-11-02 test/a.test.ts › the case", /line 1: expected/],
    ["a line with no case", "2026-11-02 abc-1.x test/a.test.ts", /line 1: expected/],
    ["a day that does not exist", "2026-02-30 abc-1.x test/a.test.ts › c", /2026-02-30 is not a date/],
    ["a ticket that is not an id", "2026-11-02 Not_An_Id test/a.test.ts › c", /Not_An_Id is not a lit ticket id/],
    ["the same case twice", `${line}\n${line}`, /line 2: .* is listed twice/],
  ])("refuses %s, and says which line", (_title, text, message) => {
    expect(() => quarantine.parseQuarantine(text)).toThrow(message);
  });

  it("leaves a mark with a real stack that names the ticket, and finds it among other failures", () => {
    const mark = quarantine.markError("abc-1.x");
    // jest hands the reporter this text: the stack, whose header names the class.
    expect(mark.stack).toMatch(/^QuarantineMark: quarantined: abc-1\.x\n\s+at /);
    expect(quarantine.markedTicket(["Error: boom\n    at x", mark.stack])).toBe("abc-1.x");
    expect(quarantine.markedTicket(["Error: boom\n    at x"])).toBeUndefined();
    expect(quarantine.markedTicket([])).toBeUndefined();
  });

  it("is not forged by a test that throws the same words", () => {
    const forged = new Error("quarantined: abc-1.x");
    expect(quarantine.markedTicket([forged.stack ?? ""])).toBeUndefined();
    expect(quarantine.markedTicket([new Error("QuarantineMark: quarantined: abc-1.x").stack ?? ""])).toBeUndefined();
  });

  it("reads a line dated more than a day ahead as red, and one day ahead as an author east of UTC", () => {
    const [entry] = quarantine.parseQuarantine("2026-11-03 candybar-testing-ihvy.hcl test/a.test.ts › c");
    expect(quarantine.expired(entry, Date.UTC(2026, 10, 2, 14, 30))).toBe(false);
    expect(quarantine.expired(entry, Date.UTC(2026, 10, 1, 23, 0))).toBe(true);
    const [typo] = quarantine.parseQuarantine("2062-11-02 candybar-testing-ihvy.hcl test/a.test.ts › c");
    expect(quarantine.expired(typo, Date.UTC(2026, 10, 2))).toBe(true);
  });

  it("is one day short of expired at 7 days and expired from the 8th", () => {
    const [entry] = quarantine.parseQuarantine(line);
    const at = (days: number, ms = 0) => entry.addedAt + days * 86_400_000 + ms;
    expect(quarantine.ageDays(entry, at(0))).toBe(0);
    expect(quarantine.ageDays(entry, at(7, 86_399_999))).toBe(7);
    expect(quarantine.expired(entry, at(7, 86_399_999))).toBe(false);
    expect(quarantine.expired(entry, at(8))).toBe(true);
  });
});
