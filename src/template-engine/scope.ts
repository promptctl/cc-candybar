// [LAW:dataflow-not-control-flow] A lazy Proxy over the flat variable store:
// nothing is materialised, so MobX tracking fires only at the leaf read.
// The engine's getField() tests `name in obj` first, hence the `has` trap.

import type { VariableStore } from "../var-system/store.js";
import type { JsonValue } from "../var-system/types.js";
import type { Outcome } from "../utils/outcome.js";

// Call once per render; do not cache across renders.
export function buildScope(store: VariableStore): object {
  const names = new Set(store.names());
  return makeProxy(store, names, "");
}

function makeProxy(
  store: VariableStore,
  names: Set<string>,
  prefix: string,
): object {
  return new Proxy(Object.create(null) as object, {
    has(_, key: string | symbol): boolean {
      if (typeof key !== "string") return false;
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (names.has(fullKey)) return true;
      const nsPrefix = `${fullKey}.`;
      for (const n of names) {
        if (n.startsWith(nsPrefix)) return true;
      }
      return false;
    },

    get(_, key: string | symbol): unknown {
      if (typeof key !== "string") return undefined;
      const fullKey = prefix ? `${prefix}.${key}` : key;

      // A document leaf hands the engine the document; its fields are the
      // rest of the chain.
      if (names.has(fullKey)) {
        return store.getKind(fullKey) === "document"
          ? unwrapDocument(fullKey, store.readDocument(fullKey))
          : store.read(fullKey);
      }

      const nsPrefix = `${fullKey}.`;
      for (const n of names) {
        if (n.startsWith(nsPrefix)) {
          return makeProxy(store, names, fullKey);
        }
      }

      return undefined;
    },
  });
}

// [LAW:no-silent-failure] THE place a document's non-value states become an
// error; a document never reads as an empty value.
function unwrapDocument(name: string, doc: Outcome<JsonValue>): JsonValue {
  switch (doc.kind) {
    case "ok":
      return doc.value;
    case "absent":
      throw new Error(
        `variable "${name}" has no value yet: its source has not completed a scan`,
      );
    case "failed":
      throw new Error(`variable "${name}": ${doc.reason}`);
  }
}
