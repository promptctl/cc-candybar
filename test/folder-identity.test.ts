import { systemFilesystem } from "../src/disk/system-filesystem";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  boundKey,
  boundOf,
  identityKey,
  statIdentity,
} from "../src/utils/folder-identity";

// A storage owner judges its folder, so a stat that fails for any reason but
// a missing path throws. A watch only names its directory, so the same
// failure is its key: never thrown, never hidden, and gone when the directory
// becomes readable.
describe("folder identity as a watch's key", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "folder-identity-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a directory's key is its identity, and nothing at the path is gone", () => {
    expect(boundKey(boundOf(systemFilesystem, dir))).toBe(identityKey(statIdentity(systemFilesystem, dir)));
    expect(boundKey(boundOf(systemFilesystem, path.join(dir, "missing")))).toBe("gone");
  });

  test("a directory that cannot be stat'd is thrown to a judge and spelled to a key", () => {
    const loop = path.join(dir, "loop");
    fs.symlinkSync(loop, loop);
    expect(() => statIdentity(systemFilesystem, loop)).toThrow(/ELOOP/);
    expect(boundOf(systemFilesystem, loop)).toEqual({ unreadable: "ELOOP" });
    expect(boundKey(boundOf(systemFilesystem, loop))).toBe("unreadable:ELOOP");
    fs.unlinkSync(loop);
    fs.mkdirSync(loop);
    expect(boundKey(boundOf(systemFilesystem, loop))).toBe(identityKey(statIdentity(systemFilesystem, loop)));
  });
});
