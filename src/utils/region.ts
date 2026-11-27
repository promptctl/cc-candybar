import {
  INTEGER_WIDTHS,
  isIntegerPresentation,
  type IntegerPresentation,
} from "./integer-presentation.js";

// [LAW:effects-at-boundaries] The host resolves these facts at startup and
// records them with the renderer boot. Peers may have different ICU data.
export interface RegionalSettings {
  readonly locale: string;
  readonly timeZone: string;
  readonly integers: IntegerPresentation;
}

export function regionFor(locale: string, timeZone: string): RegionalSettings {
  if (!Intl.NumberFormat.supportedLocalesOf([locale]).length)
    throw new RangeError(`No integer presentation data for ${locale}`);
  const formatter = new Intl.NumberFormat(locale);
  const digits = Array.from(
    { length: 10 },
    (_, n) =>
      formatter.formatToParts(n).find((part) => part.type === "integer")
        ?.value ?? "",
  );
  function patterns(sign: number): string[] {
    return Array.from({ length: INTEGER_WIDTHS }, (_, places) =>
      formatter
        .formatToParts(sign * 10 ** places)
        .map((part) =>
          part.type === "integer"
            ? "#".repeat([...part.value].length)
            : part.value,
        )
        .join(""),
    );
  }
  const integers = { digits, positive: patterns(1), negative: patterns(-1) };
  if (!isIntegerPresentation(integers))
    throw new Error(
      `Cannot capture decimal integer presentation for ${locale}`,
    );
  return { locale, timeZone, integers };
}

export function systemRegion(): RegionalSettings {
  return regionFor(
    new Intl.NumberFormat().resolvedOptions().locale,
    new Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
}
