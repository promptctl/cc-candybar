// [LAW:one-type-per-behavior] Every variable, source kind and template result lands here.

export type VarType = "string" | "number" | "boolean";
export type VarValue = string | number | boolean;

// [LAW:types-are-the-program] Not a VarValue: a document is a NAMESPACE, read by path.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// [LAW:single-enforcer] Null prototypes: the engine walks fields with `in`, so a plain
// object would expose `constructor`/`toString` as a user's fields. Sorted keys make
// JSON.stringify a canonical change measure. Frozen: sprig's `set`/`merge` assign in place.
export function toDocument(value: unknown): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map(toDocument));
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    for (const [key, v] of entries) out[key] = toDocument(v);
    return Object.freeze(out);
  }
  return value as JsonValue;
}

export function typeOf(v: VarValue): VarType {
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return t;
  // [LAW:no-defensive-null-guards] A trust boundary: fail here, never downstream.
  throw new TypeError(
    `Variable values must be string|number|boolean (got ${t})`,
  );
}

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
    throw new TypeError(
      `Cannot cast number ${v} to bool (only 0 and 1 are accepted)`,
    );
  }
  if (v === "true") return true;
  if (v === "false") return false;
  throw new TypeError(
    `Cannot cast ${JSON.stringify(v)} to bool (expected "true" or "false")`,
  );
}
