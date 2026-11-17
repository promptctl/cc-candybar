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
  // [LAW:one-source-of-truth] The documents filed since the host was last
  // told (`drain`).
  private readonly moved = new Set<Name>();
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
    const writes = [...this.moved].map((name) => this.writeOf(name));
    this.moved.clear();
    return writes;
  }

  private writeOf(name: Name): StoreWrite {
    const held = this.held[name];
    // [LAW:no-silent-failure] Only a document that read is ever filed.
    if (held.kind !== "ok")
      throw new Error(`doctor document ${name} was filed over a failed read`);
    return { store: name, value: held.value } as StoreWrite;
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
        this.moved.add(name);
        return filed;
      },
    };
  }
}
