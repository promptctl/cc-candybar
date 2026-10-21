// [LAW:effects-at-boundaries] The effect half of src/attach-preload.ts: the
// facts gathered, then one execve, or one line saying why not and exit 1. Bun
// runs this inside `claude` (its build is `dist/attach-preload.cjs`,
// tsdown.config.ts); node never loads it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planExec } from "./attach-preload.js";

interface Ffi {
  readonly dlopen: (
    lib: string,
    symbols: Record<string, { args: string[]; returns: string }>,
  ) => { symbols: Record<string, (...args: unknown[]) => number> };
  readonly ptr: (view: ArrayBufferView) => number;
  readonly read: { readonly i32: (at: number, offset?: number) => number };
}

const ERRNO_NAMES = new Map(
  Object.entries(os.constants.errno).map(([name, n]) => [n, name]),
);

const runs = (file: string, mode: number): boolean => {
  try {
    fs.accessSync(file, mode);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

function refuse(why: string): never {
  process.stderr.write(
    `cc-candybar: not attached — ${why}; nothing was started\n`,
  );
  process.exit(1);
}

// execve(2) through Bun's FFI: Bun has no exec of its own. Every buffer is
// held by `keep` until the call, which on success never returns; what it
// returns is why not.
function execve(
  file: string,
  argv: readonly string[],
  env: readonly string[],
): string {
  let ffi: Ffi;
  let libc: ReturnType<Ffi["dlopen"]>;
  try {
    ffi = require("bun:ffi") as Ffi;
    libc = ffi.dlopen(
      process.platform === "darwin"
        ? "/usr/lib/libSystem.B.dylib"
        : "libc.so.6",
      {
        execve: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
        // errno's address, as each libc spells it.
        [process.platform === "darwin" ? "__error" : "__errno_location"]: {
          args: [],
          returns: "ptr",
        },
      },
    );
  } catch (err) {
    return `execve is not reachable through Bun's FFI here: ${err instanceof Error ? err.message : String(err)}`;
  }
  const { ptr, read } = ffi;
  const keep: ArrayBufferView[] = [];
  const cString = (s: string): Buffer => {
    const b = Buffer.from(`${s}\0`);
    keep.push(b);
    return b;
  };
  const vector = (words: readonly string[]): BigUint64Array => {
    const v = new BigUint64Array(words.length + 1);
    words.forEach((w, i) => {
      v[i] = BigInt(ptr(cString(w)));
    });
    keep.push(v);
    return v;
  };
  libc.symbols.execve!(ptr(cString(file)), ptr(vector(argv)), ptr(vector(env)));
  const errnoAt = (libc.symbols.__error ?? libc.symbols.__errno_location)!;
  const errno = read.i32(errnoAt());
  return `execve ${file} failed: ${ERRNO_NAMES.get(errno) ?? `errno ${errno}`}`;
}

const canonical = (file: string): string => {
  try {
    return fs.realpathSync(file);
  } catch {
    // Names nothing on disk: then it is not this file, and its own spelling
    // is its identity.
    return path.resolve(file);
  }
};

const plan = planExec({
  self: __filename,
  executable: fs.realpathSync(process.execPath),
  argv: process.argv,
  env: process.env,
  exists: (file) => runs(file, fs.constants.R_OK),
  isExecutable: (file) => runs(file, fs.constants.X_OK),
  canonical,
});
if (plan.kind === "refused") refuse(plan.why);
refuse(execve(plan.file, plan.argv, plan.env));
