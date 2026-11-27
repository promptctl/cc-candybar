// [LAW:types-are-the-program] The template engine admits safe integers. A
// decimal magnitude has at most sixteen places, so the host can describe
// every grouping pattern once, including locales that leave 1000 ungrouped.
export const INTEGER_WIDTHS = String(Number.MAX_SAFE_INTEGER).length;

export interface IntegerPresentation {
  readonly digits: readonly string[];
  readonly positive: readonly string[];
  readonly negative: readonly string[];
}

function arePatterns(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length === INTEGER_WIDTHS &&
    value.every(
      (pattern: unknown, index) =>
        typeof pattern === "string" && pattern.split("#").length === index + 2,
    )
  );
}

export function isIntegerPresentation(
  value: unknown,
): value is IntegerPresentation {
  if (
    typeof value !== "object" ||
    value === null ||
    !("digits" in value) ||
    !("positive" in value) ||
    !("negative" in value)
  )
    return false;
  const { digits } = value;
  return (
    Array.isArray(digits) &&
    digits.length === 10 &&
    digits.every(
      (digit: unknown) => typeof digit === "string" && [...digit].length === 1,
    ) &&
    new Set(digits).size === 10 &&
    arePatterns(value.positive) &&
    arePatterns(value.negative)
  );
}

// [LAW:effects-at-boundaries] Only the host consults its locale data. A peer
// just fills the digit positions in the pattern, retaining every separator,
// minus sign and bidirectional mark from the captured representation.
export function formatInteger(
  n: number,
  presentation: IntegerPresentation,
): string {
  const magnitude = String(Math.abs(n));
  const signed =
    n < 0 || Object.is(n, -0) ? presentation.negative : presentation.positive;
  const pattern = signed[magnitude.length - 1]!;
  let index = 0;
  return pattern.replace(
    /#/g,
    () => presentation.digits[magnitude.charCodeAt(index++) - 48]!,
  );
}
