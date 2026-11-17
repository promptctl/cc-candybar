// [LAW:one-source-of-truth] A renderer's stored state as the host holds it
// (docs/design/host-and-renderer.md §7): read from its profile's files once,
// as the daemon starts, handed to every start of the renderer whole, and
// moved only by the `store` writes its turns return. The memory is the
// authority; each store's file is written behind it, so a renderer that ends
// however it ends loses nothing a turn returned.

import path from "node:path";
import type { DaemonLogger } from "../utils/logger";
import type { Timekeeper } from "../time";
import type { JsonValue } from "../var-system/types";
import {
  DOCUMENT_KEY,
  STORE_NAMES,
  type StoreName,
  type StoreWrite,
  type StoredState,
  type StoredStore,
} from "../renderer-interface/stored";
import { DebouncedStoreFile, type StoreFile } from "./store-file";

export interface ProfileStore {
  // What a start hands in: every store as the renderer last wrote it.
  stored(): StoredState;
  apply(write: StoreWrite): void;
  // [LAW:no-ambient-temporal-coupling] The daemon's close: every owed write
  // lands, and a write after it stays in memory, so it never lands over the
  // files a next daemon has taken up.
  close(): void;
}

// [LAW:types-are-the-program] How a store's entries are its file: a keyed
// store is one object of its entries; a document store is one document, the
// entry at DOCUMENT_KEY, as the doctor has always written it.
interface Codec {
  readonly file: string;
  readonly text: (entries: ReadonlyMap<string, JsonValue>) => string;
  readonly entries: (doc: JsonValue) => StoredStore;
}

const isObject = (
  doc: JsonValue,
): doc is { readonly [key: string]: JsonValue } =>
  doc !== null && typeof doc === "object" && !Array.isArray(doc);

const keyed = (file: string): Codec => ({
  file,
  text: (entries) => JSON.stringify(Object.fromEntries(entries)),
  entries: (doc) =>
    isObject(doc)
      ? { kind: "read", entries: doc }
      : { kind: "unreadable", reason: `${file} is not an object` },
});

const NO_ENTRIES: Readonly<Record<string, JsonValue>> = {};

// [LAW:one-source-of-truth] A document that went is written as `null`, and
// `null` reads back as no document, so the file says what the store holds.
const document = (file: string): Codec => ({
  file,
  text: (entries) =>
    `${JSON.stringify(entries.get(DOCUMENT_KEY) ?? null, null, 2)}\n`,
  entries: (doc) => ({
    kind: "read",
    entries: doc === null ? NO_ENTRIES : { [DOCUMENT_KEY]: doc },
  }),
});

// [LAW:one-source-of-truth] Each store's file under a profile: the names an
// installed bar has always kept them under.
const CODECS: Readonly<Record<StoreName, Codec>> = {
  session: keyed("session-state.json"),
  history: keyed("settings-history.json"),
  "doctor-marks": document("doctor-marks.json"),
  "doctor-clicked": document("doctor-clicked-terminals.json"),
  "doctor-post-mortems-read": document("doctor-post-mortems-read.json"),
};

// Where the `name` store of the profile at `dir` is kept.
export const storePath = (dir: string, name: StoreName): string =>
  path.join(dir, CODECS[name].file);

interface Held {
  // Why its file did not read, until the renderer first writes the store.
  unreadable: string | null;
  readonly entries: Map<string, JsonValue>;
  file: StoreFile | null;
}

// [LAW:no-silent-failure] A file that does not read hands in why, which the
// renderer says; its store starts empty, and the renderer's first write to
// it replaces it, as a store that could not be read always has.
function readStore(file: StoreFile, codec: Codec): StoredStore {
  const text = file.read();
  if (text.kind === "failed")
    return { kind: "unreadable", reason: text.reason };
  if (text.value === null) return { kind: "read", entries: {} };
  try {
    return codec.entries(JSON.parse(text.value) as JsonValue);
  } catch (e) {
    return {
      kind: "unreadable",
      reason: `${codec.file} is not JSON: ${(e as Error).message}`,
    };
  }
}

export function profileStore(
  dir: string,
  clock: Pick<Timekeeper, "after" | "monotonic">,
  // A write the disk refused, for every bar.
  failed: (reason: string) => void,
  logger: DaemonLogger,
): ProfileStore {
  const held = new Map<StoreName, Held>();
  for (const name of STORE_NAMES) {
    const codec = CODECS[name];
    const entries = new Map<string, JsonValue>();
    const file = new DebouncedStoreFile(
      storePath(dir, name),
      () => codec.text(entries),
      clock,
      failed,
      logger,
    );
    const read = readStore(file, codec);
    if (read.kind === "read")
      for (const [key, value] of Object.entries(read.entries))
        entries.set(key, value);
    held.set(name, {
      unreadable: read.kind === "unreadable" ? read.reason : null,
      entries,
      file,
    });
  }
  const of = (name: StoreName): Held => held.get(name) as Held;
  return {
    stored: () =>
      Object.fromEntries(
        STORE_NAMES.map((name): [StoreName, StoredStore] => {
          const store = of(name);
          return [
            name,
            store.unreadable !== null
              ? { kind: "unreadable", reason: store.unreadable }
              : { kind: "read", entries: Object.fromEntries(store.entries) },
          ];
        }),
      ) as StoredState,
    apply: ({ store, key, value }) => {
      const at = of(store);
      if (value === null) at.entries.delete(key);
      else {
        // Move-to-end: the order entries are written is the order a
        // renderer's bound keeps the newest by.
        at.entries.delete(key);
        at.entries.set(key, value);
      }
      // What the renderer wrote is what it holds from now: the reason the
      // file did not read is said once, at the start that handed it in.
      at.unreadable = null;
      at.file?.save();
    },
    close: () => {
      for (const store of held.values()) {
        store.file?.flush();
        store.file = null;
      }
    },
  };
}
