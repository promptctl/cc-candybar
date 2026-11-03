import { fieldOf, fieldsOf, valueOf } from "../../src/utils/logfmt";

describe("logfmt fieldOf", () => {
  it("reads back what valueOf wrote, bare or quoted", () => {
    const problem = 'unknown click verb: bench-1 "x" y=z';
    const line = `2026-01-01T00:00:00.000Z [info] click via=forwarder problems=${valueOf(problem)} took=3ms`;
    expect(fieldOf(line, "via")).toBe("forwarder");
    expect(fieldOf(line, "problems")).toBe(problem);
    expect(fieldOf(line, "took")).toBe("3ms");
    expect(fieldsOf(line).has("y")).toBe(false);
  });

  it("is not shadowed by a field spelled inside an earlier quoted value", () => {
    const line = `click problems=${valueOf("x via=cli")} via=forwarder`;
    expect(fieldOf(line, "via")).toBe("forwarder");
  });

  it("matches a whole key, not a suffix of another", () => {
    const line = "a xtook=9ms took=3ms";
    expect(fieldOf(line, "took")).toBe("3ms");
  });

  it("throws when the field is absent", () => {
    expect(() => fieldOf("a b=1", "c")).toThrow(/no c=/);
  });
});
