import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { open } from "node:fs/promises";
import { types } from "node:util";
import { debug } from "./logger.js";

export interface RegularTextFile {
  readonly observed: BigIntStats;
  text(): string;
  stat(): BigIntStats;
}

const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

function regular<T extends Pick<Stats, "isFile">>(stats: T): T {
  if (!stats.isFile()) throw new Error("not a file");
  return stats;
}

// [LAW:single-enforcer] Opening a pipe without a writer must never stop the
// host loop. Check the opened descriptor and read that same file, even if its
// name is replaced before the read.
export function withRegularTextFile<T>(
  path: string,
  use: (file: RegularTextFile) => T,
): T {
  return withRegularDescriptor(path, (fd, observed) =>
    use({
      observed,
      stat: () => fstatSync(fd, { bigint: true }),
      text: () => readFileSync(fd, "utf8"),
    }),
  );
}

function withRegularDescriptor<T>(
  path: string,
  use: (fd: number, observed: BigIntStats) => T,
): T {
  const fd = openSync(path, READ_FLAGS);
  try {
    return use(fd, regular(fstatSync(fd, { bigint: true })));
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

// [LAW:effects-at-boundaries] Streaming uses the same opened-file gate.
// The iterator owns the descriptor through EOF or the reader's early return.
export async function* readRegularTextLines(
  path: string,
): AsyncIterable<string> {
  const handle = await open(path, READ_FLAGS);
  try {
    regular(await handle.stat());
    const lines = handle.readLines({ encoding: "utf8", autoClose: false });
    try {
      yield* lines;
    } finally {
      lines.close();
    }
  } finally {
    await handle.close();
  }
}

// [LAW:no-silent-failure] Only a missing file can be created as an empty
// document. Keep every other read failure attached to the intended target.
export function readTextIfPresent(
  path: string,
  read: (path: string) => string = readRegularTextSync,
): string | null {
  return readIfPresent(path, read);
}

export function readBytesIfPresent(path: string): Buffer | null {
  return readIfPresent(path, (file) =>
    withRegularDescriptor(file, (fd) => readFileSync(fd)),
  );
}

function readIfPresent<T>(path: string, read: (path: string) => T): T | null {
  try {
    return read(path);
  } catch (error) {
    const native = types.isNativeError(error);
    if (native && "code" in error && error.code === "ENOENT") return null;
    const detail = native ? error.message : String(error);
    throw new Error(`${path}: ${detail}`, { cause: error });
  }
}
