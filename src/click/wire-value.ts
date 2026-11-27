// [LAW:one-source-of-truth] Each delimiter supplies the editor's character
// class and the corresponding part of the author's diagnostic.
const clickDelimiters = [
  { chars: "/", rule: "slash-free" },
  { chars: "\r\n", rule: "newline-free" },
] as const;

function wireShape(delimiters: ReadonlyArray<{ chars: string; rule: string }>) {
  const excluded = delimiters
    .map(({ chars }) => JSON.stringify(chars).slice(1, -1))
    .join("");
  // Require an absolute end even when the last character is a line break.
  const pattern = `^[^${excluded}]+(?![\\s\\S])`;
  const expression = new RegExp(pattern);
  const conditions = ["non-empty", ...delimiters.map(({ rule }) => rule)];
  const rule =
    "must be " +
    conditions.slice(0, -1).join(", ") +
    ", and " +
    conditions.at(-1);
  return {
    json: { type: "string", minLength: 1, pattern },
    rule,
    parse(raw: unknown): string | null {
      return typeof raw === "string" && expression.test(raw) ? raw : null;
    },
  };
}

export const clickValue = wireShape(clickDelimiters);
export const layoutComponent = wireShape([
  ...clickDelimiters,
  { chars: ":", rule: "colon-free" },
]);
