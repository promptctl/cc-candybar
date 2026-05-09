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

      // Leaf: exact variable in the store.
      if (names.has(fullKey)) {
        return store.read(fullKey);
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
