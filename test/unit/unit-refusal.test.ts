import { allows, isUnderRoot, refusal, type Call } from "../helpers/unit-refusal";

const ROOT = "/work/pkg";
const call = (name: string, ...args: unknown[]): Call => ({ surface: "filesystem", call: name, args });

describe("which file system calls a unit test may make", () => {
  test.each([
    ["fs.readFileSync", "/work/pkg/package.json"],
    ["fs.promises.readFile", "/work/pkg/test/fixtures/a.json"],
    ["fs.statSync", "/work/pkg"],
    ["fs.readdirSync", "/work/pkg/src"],
  ])("%s of %s reads the package's own file", (name, file) => {
    expect(allows(call(name, file), ROOT)).toBe(true);
  });

  test.each([
    ["fs.readFileSync", "/tmp/other"],
    ["fs.readFileSync", "/work/pkg-sibling/a"],
    ["fs.readFileSync", "/work/pkg/test-records/unit.jsonl"],
    ["fs.readdirSync", "/work/pkg/.git"],
    ["fs.readFileSync", "/work/pkg/dist/index.mjs"],
    ["fs.writeFileSync", "/work/pkg/out.txt"],
    ["fs.mkdtempSync", "/tmp/x-"],
    ["fs.watch", "/work/pkg/src"],
    ["fs.createWriteStream", "/work/pkg/out.txt"],
  ])("%s of %s is refused", (name, file) => {
    expect(allows(call(name, file), ROOT)).toBe(false);
  });

  test("a read that is not given a path is refused, since nothing says it is the package's", () => {
    expect(allows(call("fs.readFileSync", undefined), ROOT)).toBe(false);
  });

  test("an open that asks to write is refused and one that reads is not", () => {
    expect(allows(call("fs.openSync", "/work/pkg/a", "w"), ROOT)).toBe(false);
    expect(allows(call("fs.openSync", "/work/pkg/a", "r"), ROOT)).toBe(true);
    expect(allows(call("fs.openSync", "/work/pkg/a"), ROOT)).toBe(true);
  });

  test("a descriptor operation passes, because its open was judged", () => {
    expect(allows(call("fs.readSync", 3), ROOT)).toBe(true);
    expect(allows(call("fs.closeSync", 3), ROOT)).toBe(true);
  });

  test("every other surface is refused whole, whatever its arguments", () => {
    for (const surface of ["socket", "child process", "network", "clock"] as const) {
      expect(allows({ surface, call: "x.y", args: ["/work/pkg/package.json"] }, ROOT)).toBe(false);
    }
  });
});

describe("what lies under the package root", () => {
  test("the root, its descendants and a case-swapped spelling of them", () => {
    expect(isUnderRoot("/work/pkg", ROOT)).toBe(true);
    expect(isUnderRoot("/work/pkg/a/../b", ROOT)).toBe(true);
    expect(isUnderRoot("/WORK/pkg/b", ROOT)).toBe(true);
  });

  test("a sibling that shares the root's prefix, and a path that climbs out", () => {
    expect(isUnderRoot("/work/pkg2/a", ROOT)).toBe(false);
    expect(isUnderRoot("/work/pkg/../other", ROOT)).toBe(false);
  });
});

describe("the refusal's message", () => {
  test("names the call, the surface and the test", () => {
    const text = refusal(call("fs.writeFileSync", "/tmp/a", "data"), "writes a file");
    expect(text).toContain('reached the filesystem: fs.writeFileSync("/tmp/a", "data") in test "writes a file"');
  });

  test("says the file was loading when no test is running", () => {
    expect(refusal(call("fs.statSync", "/tmp/a"), undefined)).toContain("while the file loaded");
  });
});
