// [LAW:one-type-per-behavior] The doctor's documents as the renderer holds
// them: each as the host handed it in, read and filed in memory, and each one
// filed told to the host as the turn's stored write. A document that did not
// read stays that failure, and nothing is filed over it, as its file store
// files nothing over a file that does not read (src/doctor/state-file.ts).

import type { DoctorStoreValues } from "../daemon/foundations/stats-snapshot.js";
import type { DoctorDocument, DoctorDocuments } from "../doctor/ports.js";
import type { Asked } from "../doctor/checks.js";
import type {
  StoredState,
  StoreWrite,
} from "../renderer-interface/stored-state.js";

type Name = keyof DoctorStoreValues;

export class HeldDocuments {
  private readonly held: { -readonly [K in Name]: Asked<DoctorStoreValues[K]> };
  // [LAW:types-are-the-program] Each document filed since the host was last
  // told (`drain`), as its write: only a document that read is filed, so a
  // write holds the value it filed, and a drain has nothing to check.
  private readonly moved = new Map<Name, StoreWrite>();
  readonly documents: DoctorDocuments;

  constructor(loaded: StoredState["doctor"]) {
    this.held = { ...loaded };
    this.documents = {
      marks: this.document("marks"),
      clicked: this.document("clicked"),
      postMortemsRead: this.document("postMortemsRead"),
    };
  }

  // What the host has not yet been told: each document filed, whole.
  drain(): StoreWrite[] {
    const writes = [...this.moved.values()];
    this.moved.clear();
    return writes;
  }

  private document<K extends Name>(
    name: K,
  ): DoctorDocument<DoctorStoreValues[K]> {
    return {
      read: () => this.held[name],
      update: (next) => {
        const held = this.held[name];
        if (held.kind !== "ok") return held;
        const value = next(held.value);
        if (value === held.value) return held;
        const filed = { kind: "ok", value } as const;
        // [LAW:types-are-the-program] exception: `name` and the value are of
        // one document, which the index cannot carry to the held field's type.
        (this.held as Record<Name, Asked<DoctorStoreValues[K]>>)[name] = filed;
        this.moved.set(name, { store: name, value } as StoreWrite);
        return filed;
      },
    };
  }
}
