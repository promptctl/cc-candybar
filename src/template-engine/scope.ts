// [LAW:dataflow-not-control-flow] The scope Proxy converts a flat variable
// store (keys like "session.id", "git.branch", "cwd") into the nested object
// shape the template engine expects for ".session.id" field access.
// No data is materialised — the proxy navigates namespace prefixes lazily and
// calls store.read() only when a leaf is reached, so MobX dependency tracking
// fires at the point of actual reads inside a computed body.
//
// The engine's getField() uses `name in obj` before `obj[name]`, so the
// proxy must define a `has` trap as well as `get`.

import type { VariableStore } from "../var-system/store.js";
import type { JsonValue } from "../var-system/types.js";
import type { Outcome } from "../utils/outcome.js";

// Build the scope object the engine receives as `.` (dot).
// Call once per render; the returned object is a read-only view of the store
// at evaluation time — do not cache across renders.
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
      // Leaf: exact variable.
      if (names.has(fullKey)) return true;
      // Interior: a namespace prefix for at least one stored variable.
      const nsPrefix = `${fullKey}.`;
      for (const n of names) {
        if (n.startsWith(nsPrefix)) return true;
      }
      return false;
    },

    get(_, key: string | symbol): unknown {
      if (typeof key !== "string") return undefined;
      const fullKey = prefix ? `${prefix}.${key}` : key;

      // Leaf: exact variable in the store. A document leaf hands the engine
      // the document itself — its fields are the rest of the chain.
      if (names.has(fullKey)) {
        return store.getKind(fullKey) === "document"
          ? unwrapDocument(fullKey, store.readDocument(fullKey))
          : store.read(fullKey);
      }

      // Interior: a namespace prefix for at least one stored variable.
      // Return a nested proxy; MobX tracking fires only at the leaf read.
      const nsPrefix = `${fullKey}.`;
      for (const n of names) {
        if (n.startsWith(nsPrefix)) {
          return makeProxy(store, names, fullKey);
        }
      }

      // Unknown: `has` returned false so the engine will throw MissingFieldError.
      return undefined;
    },
  });
}

// [LAW:no-silent-failure] THE place a document's non-value states become an
// error: a read of a document that has not been scanned, or whose scan
// failed, throws naming the variable and the reason. The segment reading it
// renders that message as its ⚠ cell (and `cc-candybar check` fails on it);
// a document never reads as an empty value.
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
