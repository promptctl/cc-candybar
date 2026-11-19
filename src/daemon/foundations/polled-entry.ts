import { lstatSync, type BigIntStats } from "node:fs";
import { identityKey } from "../../utils/folder-identity.js";

export type FileObservations = ReadonlyMap<string, string>;

// [LAW:one-source-of-truth] The same revision describes an opened file to
// its reader and a path to the poll sweep. A directory's timestamps are
// about its children, which an individual polled path does not watch.
export function polledEntryOf(stat: BigIntStats): string {
  const identity = `${stat.mode}:${identityKey(stat)}`;
  return stat.isDirectory()
    ? identity
    : `${identity}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

// [LAW:no-silent-failure] A path fires when the filesystem starts refusing
// it and when it becomes readable again. The holder's own read names its
// error to the consumer.
export function readPolledEntry(at: string): string {
  try {
    return polledEntryOf(lstatSync(at, { bigint: true }));
  } catch (error) {
    return `error:${(error as NodeJS.ErrnoException).code}`;
  }
}
