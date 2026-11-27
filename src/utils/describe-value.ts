// [LAW:effects-at-boundaries] A diagnostic can contain any thrown value.
// Read data descriptors so reporting a failure never executes domain getters.
export function describeValue(
  value: unknown,
  describeError: (error: Error) => string = (error) =>
    Error.prototype.toString.call(error),
): string {
  const ancestors = new Set<object>();
  function describe(item: unknown): string {
    if (typeof item === "string")
      return "'" + JSON.stringify(item).slice(1, -1).replace(/'/g, "\\'") + "'";
    if (typeof item === "bigint") return item.toString() + "n";
    if (typeof item === "function") return "[Function]";
    if (item === null || typeof item !== "object") return String(item);
    if (item instanceof Error) return describeError(item);
    if (ancestors.has(item)) return "[Circular]";
    ancestors.add(item);
    try {
      if (item instanceof Date)
        return Number.isNaN(Date.prototype.getTime.call(item))
          ? "Invalid Date"
          : Date.prototype.toISOString.call(item);
      if (item instanceof Map)
        return (
          "Map { " +
          Array.from(
            Map.prototype.entries.call(item),
            ([k, v]) => describe(k) + " => " + describe(v),
          ).join(", ") +
          " }"
        );
      if (item instanceof Set)
        return (
          "Set { " +
          Array.from(Set.prototype.values.call(item), describe).join(", ") +
          " }"
        );
      if (item instanceof RegExp) return RegExp.prototype.toString.call(item);
      const array = Array.isArray(item);
      const fields: string[] = [];
      for (const key of Reflect.ownKeys(item)) {
        const field = Object.getOwnPropertyDescriptor(item, key);
        if (!field?.enumerable) continue;
        const content = "value" in field ? describe(field.value) : "[Accessor]";
        fields.push(
          array && typeof key === "string" && /^\d+$/.test(key)
            ? content
            : String(key) + ": " + content,
        );
      }
      if (fields.length === 0) return array ? "[]" : "{}";
      return (array ? "[ " : "{ ") + fields.join(", ") + (array ? " ]" : " }");
    } finally {
      ancestors.delete(item);
    }
  }
  return describe(value);
}
