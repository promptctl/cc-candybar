import { ZonedCalendar } from "../utils/calendar.js";
import {
  sprigDatetimeIn,
  type FuncMap,
  type TemplateFunc,
} from "@promptctl/go-template-js";

export const DATE_CLOCK_FUNCTIONS = ["now", "ago"] as const;

// ECMAScript date-only values are UTC. A timestamp with no offset is a
// wall time in the region the host recorded. Legacy dates use that same zone.
const ISO =
  /^((?!-000000)[+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?$/i;
const ZONES: Readonly<Record<string, number>> = {
  Z: 0,
  UT: 0,
  UTC: 0,
  GMT: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
};
const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

function zoneMinutes(zone: string): number {
  const named = ZONES[zone.toUpperCase()];
  if (typeof named === "number") return named;
  const offset = /^(?:GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(zone);
  if (!offset) return NaN;
  const hours = Number(offset[2]),
    minutes = Number(offset[3] ?? 0);
  return hours <= 23 && minutes <= 59
    ? (offset[1] === "-" ? -1 : 1) * (hours * 60 + minutes)
    : NaN;
}

function calendarStamp(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millis = 0,
): number {
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 24 ||
    minute > 59 ||
    second > 59 ||
    (hour === 24 && minute + second + millis !== 0)
  )
    return NaN;
  // setUTCFullYear preserves years 0..99, which Date.UTC remaps to 1900..1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.setUTCHours(hour, minute, second, millis);
}

function legacyFields(
  source: string,
): readonly [number, number, number] | undefined {
  const words = source
    .trim()
    .replace(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+/i, "")
    .split(/[\s,./-]+/);
  const named = words.findIndex((word) => /^[a-z]{3,}$/i.test(word));
  const digits = words.filter((_, index) => index !== named);
  if (!digits.length || !digits.every((word) => /^\d{1,6}$/.test(word)))
    return undefined;
  const [first = 1, second = 1, third = 2001] = digits.map(Number);
  const yearOf = (n: number) => (n < 50 ? n + 2000 : n < 100 ? n + 1900 : n);
  const yearFirst = first === 0 || first > 31;
  if (named >= 0) {
    const month = MONTHS.indexOf(words[named]!.slice(0, 3).toLowerCase()) + 1;
    if (digits.length > 2 || !month) return undefined;
    return yearFirst
      ? [yearOf(first), month, second]
      : [digits.length === 1 ? 2001 : yearOf(second), month, first];
  }
  if (digits.length > 3) return undefined;
  return yearFirst
    ? [yearOf(first), second, digits.length === 3 ? third : 1]
    : [yearOf(third), first, second];
}

function withoutDateComments(source: string): string | undefined {
  let depth = 0;
  let text = "";
  for (const char of source) {
    if (char === "(") {
      if (
        depth === 0 &&
        text &&
        !/\s$/.test(text) &&
        !/(?:GMT[+-]\d{1,2}(?::?\d{2})?|\b(?:UTC|GMT|[ECMP][SD]T)|\dZ)$/i.test(
          text,
        )
      )
        return undefined;
      depth++;
    } else if (depth) {
      if (char === ")") depth--;
    } else {
      text += char;
    }
  }
  return text.trim();
}

function legacyInstant(source: string, calendar: ZonedCalendar): number {
  const uncommented = withoutDateComments(source);
  if (!uncommented) return NaN;
  // A rejected negative-zero ISO year leaves just the month and day in
  // the legacy grammar, whose omitted year is 2001.
  let text = uncommented.replace(/^-000000-(?=\d{2}-\d{2}(?:\s|$))/, "");
  // A trailing signed number is a zone after a clock or GMT. In a
  // date alone it is a day or year, as in 15-Jan-24.
  const zone = (
    text.includes(":") || /GMT\s*[+-]/i.test(text)
      ? /(?:\s*(?:GMT\s*)?([+-]\d{1,2}(?::?\d{2})?)|\s*(UTC|GMT|UT|[ECMP][SD]T|Z))$/i
      : /(?:\s+(UTC|GMT|UT|[ECMP][SD]T)|(?<=\d)\s*(Z))$/i
  ).exec(text);
  if (zone) text = text.slice(0, zone.index).trimEnd();
  const clock =
    /[,\s]+(\d{1,2}):(\d{0,2})(?::(\d{1,2})(?:\.(\d+))?)?(?:\s*([AP]M))?$/i.exec(
      text,
    );
  const fields = legacyFields(clock ? text.slice(0, clock.index) : text);
  if (!fields) return NaN;
  let hour = Number(clock?.[1] ?? 0);
  if (clock?.[5]) {
    if (hour < 1 || hour > 12) return NaN;
    hour = (hour % 12) + (clock[5].toUpperCase() === "PM" ? 12 : 0);
  }
  const wall = calendarStamp(
    ...fields,
    hour,
    Number(clock?.[2] ?? 0),
    Number(clock?.[3] ?? 0),
    Number((clock?.[4] ?? "").padEnd(3, "0").slice(0, 3)),
  );
  if (!Number.isFinite(wall)) return NaN;
  return zone
    ? wall - zoneMinutes((zone[1] ?? zone[2])!) * 60_000
    : calendar.instantOfWallTime(wall);
}

// [LAW:single-enforcer] Interpret template text once, before Sprig sees a
// Date. Native engines disagree on legacy date strings even with a zone.
function dateInput(value: string, calendar: ZonedCalendar): Date {
  const iso = ISO.exec(value);
  let instant: number;
  if (iso) {
    const [, year, month, day, hour, minute, second, fraction, zone] = iso;
    if (hour === "24" && /[1-9]/.test(fraction ?? ""))
      throw new Error(
        `sprig: cannot parse date value ${JSON.stringify(value)}`,
      );
    const wall = calendarStamp(
      Number(year),
      Number(month ?? 1),
      Number(day ?? 1),
      Number(hour ?? 0),
      Number(minute ?? 0),
      Number(second ?? 0),
      Number((fraction ?? "").padEnd(3, "0").slice(0, 3)),
    );
    instant = zone
      ? wall - zoneMinutes(zone) * 60_000
      : hour === undefined || !Number.isFinite(wall)
        ? wall
        : calendar.instantOfWallTime(wall);
  } else {
    instant = legacyInstant(value, calendar);
  }
  const date = new Date(+instant);
  if (Number.isNaN(date.getTime()))
    throw new Error(`sprig: cannot parse date value ${JSON.stringify(value)}`);
  return date;
}

// [LAW:one-type-per-behavior] Keep the Date value Sprig expects, including its
// absolute timestamp and JSON encoding. Only its default textual projection
// needs the recorded region, whether printed bare or inside a template value.
class DisplayDate extends Date {
  readonly #describe: (date: Date) => string;

  constructor(instant: number, describe: (date: Date) => string) {
    super(instant);
    this.#describe = describe;
  }

  override toString(): string {
    return Number.isNaN(this.getTime()) ? "Invalid Date" : this.#describe(this);
  }
}

function apply(spec: FuncMap, name: string, ...args: unknown[]): unknown {
  const func = spec[name];
  if (func === undefined)
    throw new Error(`Sprig date function unavailable: ${name}`);
  return Reflect.apply(func.fn, undefined, args);
}

export function dateFunctions(timeZone: string, clock: () => Date): FuncMap {
  const calendar = new ZonedCalendar(timeZone);
  let previous: { zone: string; calendar: ZonedCalendar } | undefined;
  const forZone = (zone: string) => {
    if (zone === timeZone) return calendar;
    if (previous?.zone === zone) return previous.calendar;
    try {
      previous = { zone, calendar: new ZonedCalendar(zone) };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      // Sprig formats an unknown destination zone in UTC.
      previous = { zone, calendar: new ZonedCalendar("UTC") };
    }
    return previous.calendar;
  };
  const sprig = sprigDatetimeIn(
    clock,
    () => timeZone,
    (date, zone) => forZone(zone).partsAt(date),
    (text) => dateInput(text, calendar),
  );
  const describe = (date: Date): string => {
    const zone = calendar.nameAt(date, "long");
    const local = apply(
      sprig,
      "dateInZone",
      "Mon Jan 02 2006 15:04:05 GMT-0700",
      date,
      timeZone,
    );
    return `${String(local)} (${zone})`;
  };
  const display = (value: unknown): Date => {
    if (!(value instanceof Date))
      throw new Error("Sprig date function did not return a Date");
    return new DisplayDate(value.getTime(), describe);
  };
  const bind = (name: string, fn: TemplateFunc["fn"]): TemplateFunc => {
    const spec = sprig[name];
    if (spec === undefined)
      throw new Error(`Sprig date function unavailable: ${name}`);
    return { ...spec, fn };
  };
  const [now] = DATE_CLOCK_FUNCTIONS;
  return {
    ...sprig,
    dateModify: bind("dateModify", (duration: string, value: unknown) =>
      display(apply(sprig, "dateModify", duration, value)),
    ),
    toDate: bind("toDate", (layout: string, value: string) =>
      display(apply(sprig, "toDate", layout, value)),
    ),
    [now]: bind(now, () => display(clock())),
  };
}
