import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { birthtimeVerdict, systemFilesystem } from "../src/disk/system-filesystem";
import { identityKey, statIdentity } from "../src/utils/folder-identity";

// A host without statx, staged on the real disk: libuv's fallback copies
// ctime into birth time for every stat the process makes, the adapter's own
// probe included. The adapter decides once per process and this file is a
// module registry of its own, so the stage is up before its first stat.
describe("a folder's identity where the host copies ctime into birth time", () => {
  let dir: string;
  beforeAll(() => {
    const real = fs.statSync;
    jest.spyOn(fs, "statSync").mockImplementation(((
      at: fs.PathLike,
      options?: fs.StatSyncOptions,
    ) => {
      const st = real(at, options);
      return options?.bigint === true
        ? Object.assign(st as fs.BigIntStats, {
            birthtimeNs: (st as fs.BigIntStats).ctimeNs,
          })
        : st;
    }) as typeof fs.statSync);
  });
  afterAll(() => jest.restoreAllMocks());
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "folder-identity-fallback-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("stays put across a child write", () => {
    const before = identityKey(statIdentity(systemFilesystem, dir));
    fs.writeFileSync(path.join(dir, "child"), "x");
    fs.rmSync(path.join(dir, "child"));
    expect(identityKey(statIdentity(systemFilesystem, dir))).toBe(before);
  });

  test("is read from a probe that names the host's fallback", () => {
    statIdentity(systemFilesystem, dir);
    expect(birthtimeVerdict()).toEqual({ kind: "ctime" });
  });
});
