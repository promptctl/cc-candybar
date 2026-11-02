// [LAW:single-enforcer] What the unit project refuses, and nothing else decides
// it. A unit test runs on pure code and fakes, so a call that reaches the disk,
// a socket, a child process, the network or the real clock is a test that is
// not a unit test, and it fails at that call with the call and the test named.
// The decision is here as plain data in and a verdict out; test/unit-setup.ts
// is the one place that wires it onto the sandbox's modules and globals.

import path from "node:path";
import { fileURLToPath } from "node:url";

export type Surface = "filesystem" | "socket" | "child process" | "network" | "clock";

export interface Call {
  readonly surface: Surface;
  // The module and function, or the global, as a person would write the call.
  readonly call: string;
  readonly args: readonly unknown[];
}

// The repository's own files: the checkout's, apart from what git ignores
// (builds, records, logs, local files, other worktrees) and its own .git. `ignored`
// is what `git ls-files --others --ignored --directory` names, relative to the
// root; .gitignore owns the set, and test/helpers/package-files.ts reads it.
export interface PackageFiles {
  readonly root: string;
  readonly ignored: readonly string[];
}

// Reads of those files are the same data on every run, so they pass. Anything
// else a unit test touches is refused: writes, temp directories, watchers,
// sockets, spawns.
const FS_READS = new Set([
  "readFileSync", "readFile", "readdirSync", "readdir", "statSync", "stat",
  "lstatSync", "lstat", "existsSync", "exists", "accessSync", "access",
  "readlinkSync", "readlink", "realpathSync", "realpath", "opendirSync",
  "opendir", "createReadStream", "openSync", "open",
]);
// A descriptor was judged when it was opened.
export const FS_DESCRIPTOR_OPS = new Set(["readSync", "read", "closeSync", "close", "fstatSync", "fstat"]);

function pathOf(arg: unknown): string | null {
  if (typeof arg === "string") return arg;
  if (arg instanceof URL) return fileURLToPath(arg);
  if (Buffer.isBuffer(arg)) return arg.toString();
  return null;
}

const nameOf = (call: string): string => call.split(".").pop() ?? call;

// open and openSync read unless their flags ask for more.
function opensForReading(call: string, args: readonly unknown[]): boolean {
  if (nameOf(call) !== "openSync" && nameOf(call) !== "open") return true;
  const flags = args[1];
  return flags === undefined || flags === "r" || flags === "rs" || flags === "sr";
}

// Compared without case: TypeScript probes whether the file system is
// case-sensitive by reading its own file under a case-swapped name, and on a
// case-insensitive one that is the package's file.
export function isUnderRoot(file: string, root: string): boolean {
  const resolved = path.resolve(file).toLowerCase();
  const rootLower = path.resolve(root).toLowerCase();
  return resolved === rootLower || resolved.startsWith(rootLower + path.sep);
}

function isPackageFile(file: string, { root, ignored }: PackageFiles): boolean {
  return (
    isUnderRoot(file, root) &&
    ![".git", ...ignored].some((entry) => isUnderRoot(file, path.join(root, entry)))
  );
}

export function allows({ surface, call, args }: Call, files: PackageFiles): boolean {
  if (surface !== "filesystem") return false;
  const name = nameOf(call);
  if (FS_DESCRIPTOR_OPS.has(name)) return true;
  if (!FS_READS.has(name) || !opensForReading(call, args)) return false;
  const file = pathOf(args[0]);
  return file !== null && isPackageFile(file, files);
}

function shown(arg: unknown): string {
  const file = pathOf(arg);
  if (file !== null) return JSON.stringify(file);
  return typeof arg === "function" ? "fn" : typeof arg === "object" ? "{...}" : String(arg);
}

export function refusal(call: Call, testName: string | undefined): string {
  const where = testName === undefined ? "outside a test (while the file loaded, or in a beforeAll or afterAll hook)" : `in test "${testName}"`;
  const shownCall = `${call.call}(${call.args.slice(0, 2).map(shown).join(", ")})`;
  return (
    `a unit test reached the ${call.surface}: ${shownCall} ${where}. ` +
    `A file under test/unit needs no ${call.surface}: put it behind a port and test against a fake, ` +
    `or move the file to the test/ root until a seam exists.`
  );
}
