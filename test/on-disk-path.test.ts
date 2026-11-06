// A directory's on-disk spelling: one per directory, whatever link named it,
// with the names not yet created spelled as they will be.

import { systemFilesystem } from "../src/disk/system-filesystem";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { canonicalDirectory, onDiskDirectory } from "../src/utils/on-disk-path";

let real: string;
beforeEach(() => {
  real = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-odp-")));
  fs.mkdirSync(path.join(real, "dir"));
  fs.symlinkSync(path.join(real, "dir"), path.join(real, "link"));
});
afterEach(() => {
  fs.chmodSync(path.join(real, "dir"), 0o755);
  fs.rmSync(real, { recursive: true, force: true });
});

test("a directory reached through a link is spelled where the link points", () => {
  expect(onDiskDirectory(systemFilesystem, path.join(real, "link"))).toBe(path.join(real, "dir"));
});

test("names not created yet are spelled as named, under the deepest directory that exists", () => {
  expect(onDiskDirectory(systemFilesystem, path.join(real, "link", "new", "deeper"))).toBe(
    path.join(real, "dir", "new", "deeper"),
  );
});

test("a file in a directory's place is not a directory: the walk spells past it", () => {
  fs.writeFileSync(path.join(real, "dir", "f"), "");
  expect(canonicalDirectory(systemFilesystem, path.join(real, "link", "f"))).toBeNull();
  expect(onDiskDirectory(systemFilesystem, path.join(real, "link", "f", "x"))).toBe(path.join(real, "dir", "f", "x"));
});

test("a directory that can't be searched gives a spelling, not a throw: the path's reader reports it", () => {
  fs.mkdirSync(path.join(real, "dir", "inner"));
  fs.chmodSync(path.join(real, "dir"), 0o000);
  expect(onDiskDirectory(systemFilesystem, path.join(real, "link", "inner"))).toBe(path.join(real, "dir", "inner"));
});

// Only a case-insensitive volume has two letter cases for one directory.
const caseInsensitive = fs.existsSync(os.tmpdir().toUpperCase());
(caseInsensitive ? test : test.skip)(
  "on a case-insensitive volume, the case the disk holds",
  () => {
    expect(onDiskDirectory(systemFilesystem, path.join(real, "DIR"))).toBe(path.join(real, "dir"));
  },
);
