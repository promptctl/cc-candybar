import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  probeBirthtimeIn,
  systemFilesystemFor,
} from "../src/disk/system-filesystem";
import { systemTimekeeper } from "../src/time";
import { identityKey, statIdentity } from "../src/utils/folder-identity";

// A host without statx, staged on the real disk: libuv's fallback copies
// ctime into birth time for every stat the process makes, the probe's own
// included.
describe("a folder's identity where the host copies ctime into birth time", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "folder-identity-fallback-"));
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
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("is probed as a ctime copy, and the probe leaves no folder behind", () => {
    expect(probeBirthtimeIn(dir, systemTimekeeper)).toEqual({ kind: "ctime" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("stays put across a child write, on the disk built over the probe", () => {
    const disk = systemFilesystemFor(probeBirthtimeIn(dir, systemTimekeeper));
    const before = identityKey(statIdentity(disk, dir));
    fs.writeFileSync(path.join(dir, "child"), "x");
    fs.rmSync(path.join(dir, "child"));
    expect(identityKey(statIdentity(disk, dir))).toBe(before);
  });
});
