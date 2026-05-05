// [LAW:one-type-per-behavior] Every variable, every source kind, every
// template result lands in this same union. Adding a new value type would
// be a code change that ripples through the cast helpers and the filter
// pipeline — there is no "extra" variant available at the type layer.

export type VarType = "string" | "number" | "boolean";
export type VarValue = string | number | boolean;

export function typeOf(v: VarValue): VarType {
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return t;
  // [LAW:no-defensive-null-guards] This is a trust-boundary check —
  // values arrive from user-authored templates and external sources, so
  // an unsupported runtime value must fail loudly here, not silently
  // downstream.
  throw new TypeError(`Variable values must be string|number|boolean (got ${t})`);
}

// Cast helpers used by the filter pipeline (chunk 2 will consume these).
// Each cast either returns a typed value or throws with a useful message.
// Total casts (toString) never throw; partial casts (toNumber, toBool)
// throw on ambiguous input rather than silently coercing.

export function toString(v: VarValue): string {
  return typeof v === "string" ? v : String(v);
}

export function toNumber(v: VarValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const trimmed = v.trim();
  if (trimmed === "") {
    throw new TypeError(`Cannot cast empty string to number`);
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    throw new TypeError(`Cannot cast ${JSON.stringify(v)} to number`);
  }
  return n;
}

export function toBool(v: VarValue): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (v === 0 || v === 1) return v === 1;
    throw new TypeError(`Cannot cast number ${v} to bool (only 0 and 1 are accepted)`);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  throw new TypeError(`Cannot cast ${JSON.stringify(v)} to bool (expected "true" or "false")`);
}
