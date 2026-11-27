// [LAW:effects-at-boundaries] Diagnostics preserve data without running a
// domain getter or depending on an engine's stack or object inspector.
function errorText(
  error: Error,
  key: "name" | "message",
  fallback: string,
): string {
  for (
    let source: object | null = error;
    source;
    source = Object.getPrototypeOf(source)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    if (
      typeof DOMException !== "undefined" &&
      source === DOMException.prototype &&
      descriptor.get
    )
      return descriptor.get.call(error);
    return typeof descriptor.value === "string" ? descriptor.value : fallback;
  }
  return fallback;
}

export function isReportedError(value: unknown): value is Error {
  return (
    value instanceof Error ||
    (typeof DOMException !== "undefined" && value instanceof DOMException)
  );
}
export function errorMessage(error: Error): string {
  return errorText(error, "message", "");
}

export const UNINSPECTABLE = "[Uninspectable value]";

export function diagnosticMessage(value: unknown): string {
  try {
    return isReportedError(value) ? errorMessage(value) : describeValue(value);
  } catch {
    return UNINSPECTABLE;
  }
}

export function describeValue(
  value: unknown,
  crossed?: (error: Error) => string | undefined,
): string {
  const path = new Set<object>();
  let remaining = 100;
  const limit = (text: string) =>
    text.length > 4096 ? text.slice(0, 4096) + "…" : text;
  function describe(item: unknown): string {
    if (--remaining < 0 || path.size >= 10) return "…";
    try {
      if (typeof item === "string")
        return (
          "'" +
          JSON.stringify(limit(item)).slice(1, -1).replace(/'/g, "\\'") +
          "'"
        );
      if (typeof item === "bigint") return item.toString() + "n";
      if (typeof item === "function") return "[Function]";
      if (item === null || typeof item !== "object") return String(item);
      if (path.has(item)) return "[Circular]";
      path.add(item);
      try {
        return limit(objectDetail(item));
      } finally {
        path.delete(item);
      }
    } catch {
      // Revoked proxies and proxies of native collections can refuse even
      // their own descriptors or internal slots. Preserve the other causes.
      return UNINSPECTABLE;
    }
  }
  const descriptorText = (field: PropertyDescriptor) =>
    "value" in field ? describe(field.value) : "[Accessor]";
  function objectDetail(item: object): string {
    if (isReportedError(item)) {
      const original = crossed?.(item);
      if (original !== undefined) return original;
      const lines = [
        [errorText(item, "name", "Error"), errorMessage(item)]
          .filter(Boolean)
          .join(": "),
      ];
      const cause = Object.getOwnPropertyDescriptor(item, "cause");
      if (cause) lines.push("cause: " + descriptorText(cause));
      const errors: unknown =
        item instanceof AggregateError
          ? Object.getOwnPropertyDescriptor(item, "errors")?.value
          : undefined;
      if (Array.isArray(errors)) {
        for (let i = 0; i < errors.length && remaining > 0; i++) {
          remaining--;
          const field = Object.getOwnPropertyDescriptor(errors, i);
          if (field) lines.push(`errors[${i}]: ${descriptorText(field)}`);
        }
      }
      for (const key of Object.keys(item)) {
        if (remaining <= 0) break;
        if (
          ["name", "message", "stack", "cause"].includes(key) ||
          (key === "errors" && item instanceof AggregateError)
        )
          continue;
        remaining--;
        lines.push(
          key +
            ": " +
            descriptorText(Object.getOwnPropertyDescriptor(item, key)!),
        );
      }
      if (remaining <= 0) lines.push("…");
      return lines.join("\n");
    }
    if (item instanceof Date)
      return Number.isNaN(Date.prototype.getTime.call(item))
        ? "Invalid Date"
        : Date.prototype.toISOString.call(item);
    if (item instanceof RegExp) {
      const read = (key: string) =>
        Object.getOwnPropertyDescriptor(RegExp.prototype, key)?.get?.call(item);
      const flags = [
        ["hasIndices", "d"],
        ["global", "g"],
        ["ignoreCase", "i"],
        ["multiline", "m"],
        ["dotAll", "s"],
        ["unicode", "u"],
        ["unicodeSets", "v"],
        ["sticky", "y"],
      ] as const;
      return (
        "/" +
        read("source") +
        "/" +
        flags
          .filter(([key]) => read(key))
          .map(([, flag]) => flag)
          .join("")
      );
    }
    const fields: string[] = [];
    if (item instanceof Map || item instanceof Set) {
      const map = item instanceof Map;
      if (map) {
        for (const [key, value] of Map.prototype.entries.call(item)) {
          if (remaining <= 0) {
            fields.push("…");
            break;
          }
          fields.push(describe(key) + " => " + describe(value));
        }
      } else {
        for (const entry of Set.prototype.values.call(item)) {
          if (remaining <= 0) {
            fields.push("…");
            break;
          }
          fields.push(describe(entry));
        }
      }
      return (map ? "Map" : "Set") + " { " + fields.join(", ") + " }";
    }
    const array = Array.isArray(item);
    let next = 0;
    const holes = (end: number) => {
      if (end > next) fields.push(`<${end - next} empty>`);
    };
    for (const key of Reflect.ownKeys(item)) {
      if (remaining-- <= 0) {
        fields.push("…");
        break;
      }
      const field = Object.getOwnPropertyDescriptor(item, key);
      if (!field?.enumerable) continue;
      if (
        array &&
        typeof key === "string" &&
        String(Number(key)) === key &&
        Number.isInteger(Number(key)) &&
        Number(key) >= 0 &&
        Number(key) < item.length
      ) {
        holes(Number(key));
        next = Number(key) + 1;
        fields.push(descriptorText(field));
      } else fields.push(String(key) + ": " + descriptorText(field));
    }
    if (array && remaining > 0) holes(item.length);
    if (!fields.length) return array ? "[]" : "{}";
    return (array ? "[ " : "{ ") + fields.join(", ") + (array ? " ]" : " }");
  }
  return describe(value);
}
