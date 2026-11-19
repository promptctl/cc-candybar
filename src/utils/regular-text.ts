import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  type BigIntStats,
} from "node:fs";
import { types } from "node:util";
import { debug } from "./logger.js";

export interface RegularTextFile {
  readonly observed: BigIntStats;
  text(): string;
  stat(): BigIntStats;
}

// [LAW:single-enforcer] Opening a pipe without a writer must never stop the
// host loop. Check the opened descriptor and read that same file, even if its
// name is replaced before the read.
export function withRegularTextFile<T>(
  path: string,
  use: (file: RegularTextFile) => T,
): T {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = () => fstatSync(fd, { bigint: true });
    const observed = stat();
    if (!observed.isFile()) throw new Error("not a file");
    return use({ observed, stat, text: () => readFileSync(fd, "utf8") });
  } finally {
    // [LAW:no-silent-failure] A close error must not hide the read's result.
    try {
      closeSync(fd);
    } catch (error) {
      debug(`close ${path}: ${String(error)}`);
    }
  }
}

export function readRegularTextSync(path: string): string {
  return withRegularTextFile(path, (file) => file.text());
}

// [LAW:no-silent-failure] Only a missing file can be created as an empty
// document. Keep every other read failure attached to the intended target.
export function readTextIfPresent(
  path: string,
  read: (path: string) => string = readRegularTextSync,
): string | null {
  try {
    return read(path);
  } catch (error) {
    const native = types.isNativeError(error);
    if (native && "code" in error && error.code === "ENOENT") return null;
    const detail = native ? error.message : String(error);
    throw new Error(`${path}: ${detail}`, { cause: error });
  }
}
