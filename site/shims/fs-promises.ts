import { fs } from "memfs";
const p = fs.promises;
export default p;
export const { readFile, writeFile, stat, lstat, readdir, mkdir, rm, unlink, rename, open, access, appendFile, realpath, mkdtemp, copyFile } =
  p as unknown as Record<string, never>;
