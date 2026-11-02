import { capVerdict } from "../../e2e-checks/cap-reporter.cjs";
import { parseSignoff } from "../../e2e-checks/signoff.cjs";

describe("parseSignoff", () => {
  test("returns the two numbers", () => {
    expect(parseSignoff('{ "cap": 5, "assertionsPerTest": 1 }', "f")).toEqual({ cap: 5, assertionsPerTest: 1 });
  });

  test.each([
    ["not JSON", "{", "f is not JSON"],
    ["not an object", "[5, 1]", "f must hold an object"],
    ["a missing field", '{ "cap": 5 }', "f: assertionsPerTest must be a positive integer, found undefined"],
    ["a zero", '{ "cap": 0, "assertionsPerTest": 1 }', "f: cap must be a positive integer, found 0"],
    ["a string", '{ "cap": "5", "assertionsPerTest": 1 }', 'f: cap must be a positive integer, found "5"'],
    ["a fraction", '{ "cap": 5, "assertionsPerTest": 1.5 }', "f: assertionsPerTest must be a positive integer, found 1.5"],
    ["an unknown field", '{ "cap": 5, "assertionsPerTest": 1, "slack": 2 }', "f: unknown field slack"],
  ])("fails on %s, naming the file and the field", (_name, text, message) => {
    expect(() => parseSignoff(text, "f")).toThrow(message);
  });
});

describe("capVerdict", () => {
  test.each([
    [0, 5, null],
    [5, 5, null],
    [6, 5, "end-to-end cap: 6 tests declared, the sign-off allows 5. Only Brandon raises the cap."],
  ])("%i tests under a cap of %i", (count, cap, verdict) => {
    expect(capVerdict(count, cap)).toBe(verdict);
  });
});
