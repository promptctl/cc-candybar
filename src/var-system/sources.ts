// [LAW:one-source-of-truth] Source kinds are the bridge between external
// data (render payload, environment, static config) and the VariableStore.
// All payload ingestion goes through applyInput — there is no other path
// that writes input-kind boxes during a render.
//
// Two concerns deliberately separated:
// - VariableStore: reactivity primitives (boxes, computeds, MobX scheduling)
// - SourceRegistry: source-kind semantics (path resolution, fallback chain,
//   last_error tracking)

import {
  typeOf,
  toString,
  toNumber,
  toBool,
  type VarType,
  type VarValue,
} from "./types";
import type { VariableStore } from "./store";

export interface LastError {
  readonly timestamp: number; // Date.now() epoch ms
  readonly message: string;
}

interface InputMeta {
  readonly path: string;
  readonly varDefault: VarValue | undefined;
}

// Recursively resolves a dotted path through a plain object.
// Returns undefined if any segment is absent or the traversed value is not an object.
function resolvePath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// Coerces an external primitive to a typed VarValue using the cast helpers
// from types.ts. Throws for non-primitive runtypes or impossible casts.
function coerceToType(raw: unknown, type: VarType): VarValue {
  // [LAW:no-defensive-null-guards] Trust-boundary check: payload values must be
  // primitives. Non-primitive means malformed input — fail loudly.
  if (
    typeof raw !== "string" &&
    typeof raw !== "number" &&
    typeof raw !== "boolean"
  ) {
    throw new TypeError(
      `Expected string|number|boolean from payload, got ${typeof raw}`,
    );
  }
  if (type === "string") return toString(raw);
  if (type === "number") return toNumber(raw);
  return toBool(raw);
}

// Type-appropriate zero used as the final backstop in the fallback chain when
// neither per-variable default nor defaultEmptyValue can be coerced.
function zeroValue(type: VarType): VarValue {
  if (type === "number") return 0;
  if (type === "boolean") return false;
  return "";
}

// [LAW:single-enforcer] One SourceRegistry per daemon, sharing one
// VariableStore. Multiple registries on the same store would produce
// duplicate box definitions for input-kind variables.

export class SourceRegistry {
  private readonly inputMetas = new Map<string, InputMeta>();
  private readonly lastErrors = new Map<string, LastError>();

  // defaultEmptyValue is the global fallback of last resort — the config-level
  // `default_empty_value` from the proposal. Defaults to empty string.
  constructor(
    private readonly store: VariableStore,
    private readonly defaultEmptyValue: VarValue = "",
  ) {}

  // literal: type inferred from value; box written once at declaration and never again.
  declareLiteral(name: string, value: VarValue): void {
    this.store.defineBox(name, typeOf(value), value);
  }

  // input: per-render box; initial value from fallback chain (path not yet resolved).
  // At each render, applyInput resolves path against the payload and updates the box.
  declareInput(
    name: string,
    path: string,
    type: VarType,
    varDefault?: VarValue,
  ): void {
    // [LAW:dataflow-not-control-flow] Initialize to the fallback value so the
    // box always holds a valid typed value — even before the first render push.
    const initial = varDefault !== undefined ? varDefault : this.defaultFor(type);
    this.store.defineBox(name, type, initial);
    this.inputMetas.set(name, { path, varDefault });
  }

  // env: resolved once at declaration from process.env; box written once, never again.
  // type is always 'string' — env vars are text by nature.
  declareEnv(name: string, envVar: string, varDefault?: string): void {
    const raw = process.env[envVar];
    if (raw !== undefined) {
      this.store.defineBox(name, "string", raw);
      return;
    }
    // Env var absent: apply fallback chain, record last_error.
    const fallback =
      varDefault !== undefined
        ? varDefault
        : typeof this.defaultEmptyValue === "string"
          ? this.defaultEmptyValue
          : "";
    this.store.defineBox(name, "string", fallback);
    this.recordError(name, `env var "${envVar}" is not set`);
  }

  // Called at the start of each render request. Pushes all input-kind boxes in
  // a single runInAction so their dependents invalidate exactly once.
  // [LAW:dataflow-not-control-flow] Variability lives in the payload values,
  // not in whether the update runs — every input box is refreshed every render.
  applyInput(payload: unknown): void {
    this.store.runInAction(() => {
      for (const [name, meta] of this.inputMetas) {
        const raw = resolvePath(payload, meta.path);
        const type = this.store.getType(name);
        if (raw !== undefined) {
          try {
            this.store.setBox(name, coerceToType(raw, type));
            this.lastErrors.delete(name);
          } catch (e) {
            this.applyFallback(
              name,
              type,
              meta.varDefault,
              e instanceof Error ? e.message : String(e),
            );
          }
        } else {
          this.applyFallback(
            name,
            type,
            meta.varDefault,
            `input path "${meta.path}" not found in payload`,
          );
        }
      }
    });
  }

  // Returns the recorded error for a variable, or undefined if the last
  // resolution succeeded (or the variable has never been resolved).
  getLastError(name: string): LastError | undefined {
    return this.lastErrors.get(name);
  }

  // Failure chain: per-variable default → defaultEmptyValue coerced to type → zero.
  // [LAW:no-defensive-null-guards] Each fallback level is deliberate; the zero
  // backstop is the only "silent" path and exists because the caller has already
  // recorded the error — downstream reads get a safe typed value, not an exception.
  private applyFallback(
    name: string,
    type: VarType,
    varDefault: VarValue | undefined,
    errorMessage: string,
  ): void {
    this.recordError(name, errorMessage);
    if (varDefault !== undefined) {
      this.store.setBox(name, varDefault);
      return;
    }
    try {
      this.store.setBox(name, coerceToType(this.defaultEmptyValue, type));
    } catch {
      this.store.setBox(name, zeroValue(type));
    }
  }

  // Initial value for an input box before the first render push.
  private defaultFor(type: VarType): VarValue {
    try {
      return coerceToType(this.defaultEmptyValue, type);
    } catch {
      return zeroValue(type);
    }
  }

  private recordError(name: string, message: string): void {
    this.lastErrors.set(name, { timestamp: Date.now(), message });
  }
}
