import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { debug } from "./logger.js";

// [LAW:single-enforcer] Opening a pipe without a writer must never stop the
// host loop. Check the opened descriptor and read that same file, even if its
// name is replaced before the read.
export function readRegularTextSync(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a file");
    return readFileSync(fd, "utf8");
  } finally {
    // [LAW:no-silent-failure] A close error must not hide the read's result.
    try {
      closeSync(fd);
    } catch (error) {
      debug(`close ${path}: ${String(error)}`);
    }
  }
}
