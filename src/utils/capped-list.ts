// [LAW:one-source-of-truth] How a refusal lists the values it names: the
// first few, then how many more, so a long domain stays one readable line.
const LISTED = 3;

export function cappedList(values: readonly string[]): string {
  return values.length <= LISTED
    ? values.join(", ")
    : `${values.slice(0, LISTED).join(", ")} and ${values.length - LISTED} more`;
}
