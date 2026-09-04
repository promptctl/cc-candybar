// [LAW:behavior-not-structure] The dump owner's contract: a session's file
// mirrors the diagnostic text its last render carried — present with that
// exact content, absent when there is none — and the disk is touched only
// when the desired state changes.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DiagnosticDump } from "../src/daemon/diagnostic-dump";

describe("DiagnosticDump", () => {
  let root: string;
  let dump: DiagnosticDump;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-dump-"));
    dump = new DiagnosticDump(path.join(root, "diagnostics"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("names a path before anything is written, and encodes the session id as one segment", () => {
    const p = dump.pathFor("../x/y");
    expect(path.dirname(p)).toBe(path.join(root, "diagnostics"));
    expect(path.basename(p)).toBe("..%2Fx%2Fy.txt");
    expect(existsSync(p)).toBe(false);
  });

  test("writes the text, rewrites only on change, removes on null", () => {
    const p = dump.pathFor("sid");
    dump.sync("sid", "ERROR\nboom\n");
    expect(readFileSync(p, "utf8")).toBe("ERROR\nboom\n");

    // Same text → no write: deleting the file behind its back proves it.
    rmSync(p);
    dump.sync("sid", "ERROR\nboom\n");
    expect(existsSync(p)).toBe(false);

    dump.sync("sid", "ERROR\nworse\n");
    expect(readFileSync(p, "utf8")).toBe("ERROR\nworse\n");

    dump.sync("sid", null);
    expect(existsSync(p)).toBe(false);
    // Absent stays absent without a directory ever being created for it.
    dump.sync("other", null);
    expect(existsSync(path.join(root, "diagnostics"))).toBe(true);
  });

  test("reset wipes the directory and forgets what was written", () => {
    dump.sync("a", "x");
    dump.sync("b", "y");
    dump.reset();
    expect(existsSync(path.join(root, "diagnostics"))).toBe(false);
    dump.sync("a", "x"); // forgotten → written again
    expect(readFileSync(dump.pathFor("a"), "utf8")).toBe("x");
  });
});
