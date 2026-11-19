import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  type BigIntStats,
} from "node:fs";
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
