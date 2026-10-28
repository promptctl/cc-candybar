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
import { PendingValueError, type JsonValue } from "../var-system/types.js";
import type { Reading } from "../utils/outcome.js";

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
      // Leaf: exact variable — but an absent document is a missing field,
      // so `hasKey` reads false until its source has something to say, and
      // an unguarded read is the engine's MissingFieldError. The read is
      // tracked, so a gate re-runs when the document arrives.
      if (names.has(fullKey)) return !absentDocument(store, fullKey);
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
        if (store.getKind(fullKey) !== "document") return store.read(fullKey);
        const doc = store.readDocument(fullKey);
        // Absent reads as no such key, as `has` answers.
        return doc.kind === "absent" ? undefined : unwrapDocument(fullKey, doc);
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

// [LAW:one-source-of-truth] The scope ONE placement's templates evaluate in
// (brandon-segment-settings-i4n): the render's scope, with `.settings` bound
// to that placement's resolved settings. No variable may live under
// `settings` (cross-ref.ts refuses one), so this adds a name and shadows none.
// `settings` is the compiled placement's own frozen object — the same one on
// every render — so nothing here allocates per read.
export function placementScope(scope: object, settings: object): object {
  return new Proxy(scope, {
    has: (target, key) => key === "settings" || Reflect.has(target, key),
    get: (target, key) =>
      key === "settings" ? settings : Reflect.get(target, key),
  });
}

// [LAW:one-source-of-truth] Absent is a missing field, for every document:
// one with nothing to read (no file yet, blank text, no default) is no key at
// all, so a template gates on it with `hasKey` and an unguarded read is the
// missing-field error, as for any field the payload lacks.
function absentDocument(store: VariableStore, name: string): boolean {
  return (
    store.getKind(name) === "document" &&
    store.readDocument(name).kind === "absent"
  );
}

// [LAW:no-silent-failure] THE place a document's other non-value states become
// a throw naming the variable: one not scanned yet throws the pending signal,
// which every place a template is evaluated draws as not answered yet; one
// whose scan failed throws its reason, which the segment reading it renders as
// its ⚠ cell (and `cc-candybar check` fails on). A document never reads as an
// empty value.
function unwrapDocument(
  name: string,
  doc: Exclude<Reading<JsonValue>, { kind: "absent" }>,
): JsonValue {
  switch (doc.kind) {
    case "ok":
      return doc.value;
    case "pending":
      throw new PendingValueError(
        name,
        `variable "${name}" has no value yet: its source has not completed a scan`,
      );
    case "failed":
      throw new Error(`variable "${name}": ${doc.reason}`);
  }
}
