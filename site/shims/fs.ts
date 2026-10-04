// node:fs in the page: memfs, one volume the fixture seeds and the daemon reads and writes.
import { fs, vol } from "memfs";
export { vol };
export default fs;
export const {
  existsSync, readFileSync, writeFileSync, statSync, lstatSync, readdirSync, mkdirSync, rmSync, unlinkSync,
  renameSync, openSync, readSync, closeSync, fstatSync, writeSync, appendFileSync, realpathSync, readlinkSync,
  mkdtempSync, copyFileSync, watch, watchFile, unwatchFile, constants, promises, accessSync, createReadStream,
  createWriteStream, chmodSync, utimesSync, symlinkSync, rmdirSync, ftruncateSync, fsyncSync, Stats,
} = fs as unknown as Record<string, never>;
