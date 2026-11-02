import { ignoredFrom } from "../helpers/package-files";
import { allows, isUnderRoot, refusal, type Call, type PackageFiles } from "../helpers/unit-refusal";

const ROOT: PackageFiles = { root: "/work/pkg", ignored: ["dist/", "test-records/", ".claude/worktrees/", "debug.log"] };
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
    ["fs.readFileSync", "/work/pkg/debug.log"],
    ["fs.readFileSync", "/work/pkg/.claude/worktrees/w/a.ts"],
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
    expect(allows(call("fs.open", "/work/pkg/a", () => undefined), ROOT)).toBe(true);
    expect(allows(call("fs.open", "/tmp/a", () => undefined), ROOT)).toBe(false);
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
    expect(isUnderRoot("/work/pkg", ROOT.root)).toBe(true);
    expect(isUnderRoot("/work/pkg/a/../b", ROOT.root)).toBe(true);
    expect(isUnderRoot("/WORK/pkg/b", ROOT.root)).toBe(true);
  });

  test("a sibling that shares the root's prefix, and a path that climbs out", () => {
    expect(isUnderRoot("/work/pkg2/a", ROOT.root)).toBe(false);
    expect(isUnderRoot("/work/pkg/../other", ROOT.root)).toBe(false);
  });
});

describe("the refusal's message", () => {
  test("names the call, the surface and the test", () => {
    const text = refusal(call("fs.writeFileSync", "/tmp/a", "data"), "writes a file");
    expect(text).toContain('reached the filesystem: fs.writeFileSync("/tmp/a", "data") in test "writes a file"');
  });

  test("says the call was outside a test, at load or in a hook, when no test is running", () => {
    const text = refusal(call("fs.statSync", "/tmp/a"), undefined);
    expect(text).toContain("while the file loaded");
    expect(text).toContain("beforeAll or afterAll hook");
  });
});

describe("what git's ignored listing becomes", () => {
  test("keeps a path whose name has a special character as itself", () => {
    expect(ignoredFrom("dist/\0tést/\0debug.log\0")).toEqual(["dist/", "tést/", "debug.log"]);
  });

  test("leaves node_modules at any depth out, because the lockfile pins it", () => {
    expect(ignoredFrom("node_modules/\0scripts/bar-web/node_modules/\0dist/\0")).toEqual(["dist/"]);
  });

  test("keeps a path that only ends in node_modules", () => {
    expect(ignoredFrom("my_node_modules/\0")).toEqual(["my_node_modules/"]);
  });
});
