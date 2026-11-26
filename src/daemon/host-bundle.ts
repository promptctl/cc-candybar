import path from "node:path";
import type { Host } from "../host";
import { writeAtomic } from "../utils/atomic-write";
import { presence } from "../utils/presence";
import { readTextIfPresent } from "../utils/regular-text";
import { ABSENT, failed, ok, type Outcome } from "../utils/outcome";
import { hostBundlePath } from "./paths";

// The host's bundle record: which `index.mjs` the install runs the host from.
// [LAW:single-enforcer] In this runtime the record's text
// (`hostBundleRecordText`), which the install and a checkout's record both
// write, and a client's reader (`readHostBundle`) are the only code that
// touch the file, so a client that finds no host has exactly one answer to
// "which code starts it". The Rust client mirrors the read (rust-client/src/main.rs
// read_host_bundle), and only the file's name is diffed by check-protocol.

// [LAW:parse-dont-validate] The crossing from the file's text to a bundle a
// spawn can use. `ok` is a recorded path that exists; `absent` is no record
// (nothing was ever installed here); `failed` is a record that names nothing a
// spawn could run, or one that could not be read, with the reason. A caller
// holds the path or a refusal, never a path it must re-check.
export function readHostBundle(host: Host): Outcome<string> {
  const record = hostBundlePath(host);
  let text: string | null;
  try {
    text = readTextIfPresent(record);
  } catch (error) {
    return failed((error as Error).message, "read");
  }
  if (text === null) return ABSENT;
  const bundle = text.trim();
  if (!path.isAbsolute(bundle)) {
    return failed(`${record} does not hold an absolute path`, "parse");
  }
  const there = presence(bundle);
  if (there === "present") return ok(bundle);
  return failed(
    there === "absent"
      ? `${record} names ${bundle}, which does not exist`
      : `${record} names ${bundle}, which cannot be read: ${there.error}`,
    "read",
  );
}

// [LAW:one-source-of-truth] The files whose change or loss ends a host: the
// bundle it runs, the entry it was started through (global installs, symlinks),
// and the install's record. An install that points the record at other code
// changes no file this host runs, so the record is watched too, and the host
// is the one that ends so the next client starts the recorded bundle. One
// target per path: run as `node dist/index.mjs`, the first two name one file.
export function watchedFiles(
  host: Host,
  bundle: string,
  entry: string | undefined,
): readonly string[] {
  return [
    ...new Set([
      bundle,
      ...(entry === undefined ? [] : [entry]),
      hostBundlePath(host),
    ]),
  ];
}

// What `readHostBundle` answers when it holds no bundle to spawn.
export type UnusableRecord = Exclude<Outcome<string>, { kind: "ok" }>;

export function whyUnusable(record: UnusableRecord): string {
  return record.kind === "absent"
    ? "no host bundle is recorded: run `cc-candybar install`"
    : record.reason;
}

// [LAW:no-silent-failure] Only an absolute path is a record: a relative one
// would name a different file for every client that read it.
export function hostBundleRecordText(bundle: string): string {
  if (!path.isAbsolute(bundle)) {
    throw new Error(`host bundle must be an absolute path: ${bundle}`);
  }
  return `${bundle}\n`;
}

export function recordHostBundle(host: Host, bundle: string): void {
  writeAtomic(hostBundlePath(host), hostBundleRecordText(bundle));
}
