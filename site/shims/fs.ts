// node:fs in the page: memfs, one volume the fixture seeds and the daemon reads and writes.
import { Volume, createFsFromVolume } from "memfs";
import proc from "./process";
// [LAW:one-source-of-truth] The volume is the page's machine, so it takes its
// owner from the page's `process`, as every file it holds is checked against.
// memfs's own volume reads the global `process`: no one in a browser, the
// test's own under Node, and either way not the owner a file is checked
// against, so a file only its owner may open could be opened by no one.
export const vol = Volume.fromNestedJSON({}, "/", {
  process: {
    cwd: () => "/",
    platform: proc.platform,
    env: proc.env,
    getuid: proc.getuid,
    getgid: proc.getgid,
    emitWarning: proc.emitWarning,
  },
});
const fs = createFsFromVolume(vol);
export { fs };
export default fs;
export const {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  renameSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  writeSync,
  appendFileSync,
  realpathSync,
  readlinkSync,
  mkdtempSync,
  copyFileSync,
  watch,
  watchFile,
  unwatchFile,
  constants,
  promises,
  accessSync,
  createReadStream,
  createWriteStream,
  chmodSync,
  utimesSync,
  symlinkSync,
  linkSync,
  rmdirSync,
  ftruncateSync,
  fsyncSync,
  Stats,
} = fs as unknown as Record<string, never>;
