// A renderer's stored state (docs/design/host-and-renderer.md §7): what it
// keeps across its own restarts, read by the host from the profile its name
// derives and handed in with its start, and changed only by the `store`
// writes its turns return.
//
// [LAW:one-source-of-truth] The host's copy is the one a start hands in, so a
// renderer that ends however it ends (a crash, a kill) loses only the turn it
// was in. [LAW:types-are-the-program] Nothing here names a path (I-10): a
// store is a name, and each entry a key the renderer chose.

import type { Crosses } from "./crosses";
import type { JsonValue } from "../var-system/types";

// [LAW:one-source-of-truth] One name per durable store the profile holds.
export const STORE_NAMES = [
  // Each session's picks, drafts, menus and the rest of its keys.
  "session",
  // Each session's undo history.
  "history",
  // The doctor's documents, each one whole under DOCUMENT_KEY.
  "doctor-marks",
  "doctor-clicked",
  "doctor-post-mortems-read",
] as const;
export type StoreName = (typeof STORE_NAMES)[number];

// The key a store that holds one document keeps it under: the empty address,
// as a change's empty address is its document.
export const DOCUMENT_KEY = "";

// [LAW:no-silent-failure] What the host read of a store: its entries, or why
// its file did not read, which the renderer's reads of it then say. A file
// that is missing is a store with no entries.
export type StoredStore =
  | {
      readonly kind: "read";
      readonly entries: Readonly<Record<string, JsonValue>>;
    }
  | { readonly kind: "unreadable"; readonly reason: string };

export type StoredState = Readonly<Record<StoreName, StoredStore>>;

// [LAW:effects-at-boundaries] A turn's write to one entry of a store: the
// value it now holds, or null when it holds none. Never answered: the host
// applies every write it is handed in the turn's own slot, so the copy a
// start hands in is what the renderer last held.
export interface StoreWrite {
  readonly kind: "store";
  readonly store: StoreName;
  readonly key: string;
  readonly value: JsonValue | null;
}

// A store with no entries: what a profile that holds nothing hands in.
export const EMPTY_STORE: StoredStore = { kind: "read", entries: {} };

export function emptyStoredState(): StoredState {
  return Object.fromEntries(
    STORE_NAMES.map((name) => [name, EMPTY_STORE]),
  ) as StoredState;
}

// [LAW:types-are-the-program] Both cross a process as they are.
export const STORED_CROSSES: Crosses<StoredState | StoreWrite> = true;
