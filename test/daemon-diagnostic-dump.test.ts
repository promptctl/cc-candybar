// [LAW:behavior-not-structure] The dump owner's contract: a session's file
// mirrors the diagnostic text its newest render request carried — present
// with that exact content, absent when there is none — and the disk is
// touched only when the desired state changes or a write failed.

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DiagnosticDump } from "../src/daemon/diagnostic-dump";

describe("DiagnosticDump", () => {
  let root: string;
  let dump: DiagnosticDump;
  // Each sync is the next request to arrive, unless a test says otherwise.
  let arrivals = 0;
  const sync = (sid: string, text: string | null) =>
    dump.sync(sid, ++arrivals, text);
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
    sync("sid", "ERROR\nboom\n");
    expect(readFileSync(p, "utf8")).toBe("ERROR\nboom\n");

    // Same text → no write: deleting the file behind its back proves it.
    rmSync(p);
    sync("sid", "ERROR\nboom\n");
    expect(existsSync(p)).toBe(false);

    sync("sid", "ERROR\nworse\n");
    expect(readFileSync(p, "utf8")).toBe("ERROR\nworse\n");

    sync("sid", null);
    expect(existsSync(p)).toBe(false);
    // Absent stays absent without a directory ever being created for it.
    sync("other", null);
    expect(existsSync(path.join(root, "diagnostics"))).toBe(true);
  });

  test("a write the filesystem refuses is reported as a reason, not thrown, and is retried", () => {
    // A file where the directory should be: mkdir -p fails with ENOTDIR/EEXIST.
    writeFileSync(path.join(root, "diagnostics"), "");
    expect(sync("sid", "ERROR\nboom\n")).toEqual({
      kind: "unavailable",
      reason: expect.stringMatching(/sid\.txt: /),
    });
    rmSync(path.join(root, "diagnostics"));
    // The write failed, so the same text is written again on the next request.
    expect(sync("sid", "ERROR\nboom\n")).toEqual({
      kind: "file",
      path: dump.pathFor("sid"),
    });
    expect(readFileSync(dump.pathFor("sid"), "utf8")).toBe("ERROR\nboom\n");
  });

  test("a frame drawing the text a write failed on names that failure, not a later write", () => {
    writeFileSync(path.join(root, "diagnostics"), "");
    const failed = sync("sid", "ERROR\nboom\n");
    expect(failed).toEqual({
      kind: "unavailable",
      reason: expect.stringMatching(/sid\.txt: /),
    });
    expect(dump.linkFor("sid", "ERROR\nboom\n")).toEqual(failed);
  });

  test("a request that finishes after a newer one leaves the newer one's file alone", () => {
    const p = dump.pathFor("sid");
    expect(dump.sync("sid", 2, "ERROR\nnewer\n")).toEqual({
      kind: "file",
      path: p,
    });
    expect(dump.sync("sid", 1, "ERROR\nolder\n")).toEqual({
      kind: "unavailable",
      reason: "written at the session's next statusline request",
    });
    expect(readFileSync(p, "utf8")).toBe("ERROR\nnewer\n");
    expect(dump.linkFor("sid", "ERROR\nnewer\n")).toEqual({
      kind: "file",
      path: p,
    });
  });

  test("a frame's link names the file only while it holds that frame's text, and writes nothing", () => {
    const p = dump.pathFor("sid");
    const file = { kind: "file", path: p };
    const unwritten = {
      kind: "unavailable",
      reason: "written at the session's next statusline request",
    };
    expect(dump.linkFor("sid", "ERROR\nboom\n")).toEqual(unwritten);
    expect(existsSync(p)).toBe(false);
    sync("sid", "ERROR\nboom\n");
    expect(dump.linkFor("sid", "ERROR\nboom\n")).toEqual(file);
    expect(dump.linkFor("sid", "ERROR\nworse\n")).toEqual(unwritten);
    expect(readFileSync(p, "utf8")).toBe("ERROR\nboom\n");
    sync("sid", null);
    expect(dump.linkFor("sid", null)).toEqual(file);
  });

  test("reset wipes the directory and forgets what was written", () => {
    sync("a", "x");
    sync("b", "y");
    dump.reset();
    expect(existsSync(path.join(root, "diagnostics"))).toBe(false);
    sync("a", "x"); // forgotten → written again
    expect(readFileSync(dump.pathFor("a"), "utf8")).toBe("x");
  });

  test("a wipe the filesystem refuses is reported as a reason, not thrown, and memory is still cleared", () => {
    sync("a", "x");
    // A read-only parent: the directory's own entry cannot be unlinked.
    chmodSync(root, 0o500);
    try {
      expect(dump.reset()).toMatch(/diagnostics: /);
    } finally {
      chmodSync(root, 0o700);
    }
    rmSync(path.join(root, "diagnostics"), { recursive: true, force: true });
    // Forgotten regardless: the next sync writes, it does not skip.
    expect(sync("a", "x")).toEqual({
      kind: "file",
      path: dump.pathFor("a"),
    });
    expect(readFileSync(dump.pathFor("a"), "utf8")).toBe("x");
  });
});
