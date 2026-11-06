import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { systemFilesystem } from "../../src/disk/system-filesystem";
import { filesystemContract } from "../contract/filesystem.contract";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

filesystemContract("the system filesystem", () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "filesystem-contract-")),
  );
  roots.push(root);
  return {
    filesystem: systemFilesystem,
    world: {
      write: (at, text) => fs.writeFileSync(at, text),
      mkdir: (at) => void fs.mkdirSync(at, { recursive: true }),
      symlink: (target, at) => fs.symlinkSync(target, at),
      remove: (at) => fs.rmSync(at, { recursive: true }),
    },
    root,
    // The re-applied write: a new watch can miss what lands before the OS
    // feeds it, so the nudge repeats each turn until it is heard.
    hear: async (nudge, heard) => {
      while (!heard()) {
        nudge();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
});
