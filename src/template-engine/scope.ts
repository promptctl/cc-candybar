// [LAW:dataflow-not-control-flow] Two scope builders; one seam.
//
// buildScope(store) — for user-variable computed templates.  Converts the flat
// variable store (keys like "git.branch", "cwd") into the nested object shape
// the template engine expects.  No hook data involved.
//
// buildRenderScope(hookData, store) — for segment template evaluation.  The
// hook data payload IS the scope root: {{.session_id}}, {{.model.id}} etc.
// resolve by walking hookData directly.  User-declared store variables overlay
// hook data: exact name matches shadow same-named hook data fields; dotted-name
// store vars shadow the corresponding hook data namespace.
//
// The engine's getField() uses `name in obj` before `obj[name]`, so every
// proxy must define a `has` trap as well as `get`.

import type { ClaudeHookData } from "../utils/claude.js";
import type { VariableStore } from "../var-system/store.js";
import { KNOWN_TOP_LEVEL } from "../utils/schema-validator.js";

// Build the scope object the engine receives as `.` (dot).
// Call once per render; the returned object is a read-only view of the store
// at evaluation time — do not cache across renders.
export function buildScope(store: VariableStore): object {
  const names = new Set(store.names());
  return makeProxy(store, names, "");
}

// Build the scope for segment template evaluation.
// hookData is the ClaudeHookData JSON payload; store holds user-declared vars.
// [LAW:one-source-of-truth] Hook data is the single source of hook fields —
// no parallel registry, no typed extraction.  The template engine traverses
// nested hook data objects natively via JS property access.
//
// [LAW:single-enforcer] The proxy is the single place that decides which fields
// are renderable and what absent optional fields resolve to. Known top-level
// fields are always accessible (absent optionals → ""); unknown fields →
// MissingFieldError from the engine.
export function buildRenderScope(hookData: ClaudeHookData, store: VariableStore): object {
  const names = new Set(store.names());
  return new Proxy(Object.create(null) as object, {
    has(_, key: string | symbol): boolean {
      if (typeof key !== "string") return false;
      // Store exact name or namespace prefix takes priority.
      if (names.has(key)) return true;
      const nsPrefix = `${key}.`;
      for (const n of names) if (n.startsWith(nsPrefix)) return true;
      // Known schema field → always renderable; absent optionals resolve to "".
      return KNOWN_TOP_LEVEL.has(key);
    },

    get(_, key: string | symbol): unknown {
      if (typeof key !== "string") return undefined;
      // Store exact name.
      if (names.has(key)) return store.read(key);
      // Store namespace prefix — return a store-only sub-proxy so user vars
      // with dotted names (e.g. "model.branch") shadow hook data under that prefix.
      const nsPrefix = `${key}.`;
      for (const n of names) {
        if (n.startsWith(nsPrefix)) return makeProxy(store, names, key);
      }
      // Known field: present value, or "" for absent optional top-level fields.
      // The template engine traverses nested objects natively — no proxy needed
      // for hook data children.
      if (KNOWN_TOP_LEVEL.has(key)) return hookData[key] ?? "";
      return undefined;
    },
  });
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
