import {
  sprigDatetime,
  type FuncMap,
  type TemplateFunc,
} from "@promptctl/go-template-js";

export const DATE_CLOCK_FUNCTIONS = ["now", "ago"] as const;

const SPRIG = sprigDatetime(() => {
  throw new Error(
    "a sprig date function other than now and ago read the clock",
  );
});

const DAY_MS = 86_400_000;
const DATE_LIMIT_MS = 8.64e15;
const ISO =
  /^(?:\d{4}|[+-]\d{6})(?:-\d{2}(?:-\d{2})?)?(?:(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/i;
const NAMED_ZONE = /(?:^|[^a-z])(?:ut|utc|gmt|[ecmp][sd]t|z)(?![a-z])/i;
const NUMERIC_ZONE = /\d:.*[+-]\d/s;

function legacyDate(value: string): { tokens: string; end: number } {
  // Look for zones outside parenthesized comments. Retain the original text
  // for native parsing, truncating an open comment only before adding a zone.
  if (!value.includes("(")) return { tokens: value, end: value.length };
  let depth = 0;
  let start = 0;
  let tokens = "";
  for (let i = 0; i < value.length; i++) {
    const character = value.charAt(i);
    if (character === "(") {
      if (depth === 0) {
        start = i;
        tokens += " ";
      }
      depth++;
    } else if (character === ")" && depth > 0) depth--;
    else if (depth === 0) tokens += character;
  }
  return { tokens, end: depth === 0 ? value.length : start };
}

function hasLegacyZone(value: string): boolean {
  // V8 reads a named zone after a number, or a numeric offset after a time.
  const firstNumber = value.search(/\d/);
  if (firstNumber < 0) return false;
  const timed = value.slice(firstNumber);
  return NAMED_ZONE.test(timed) || NUMERIC_ZONE.test(timed);
}

// [LAW:effects-at-boundaries] Read offsets only at supplied instants in the
// supplied zone. Native Date never interprets an unzoned timestamp itself.
function wallTimeIn(timeZone: string): (wall: number) => number {
  let offsets: Intl.DateTimeFormat | undefined;
  const offsetAt = (instant: number): number => {
    offsets ??= new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    });
    const name = offsets
      .formatToParts(instant)
      .find(({ type }) => type === "timeZoneName")?.value;
    if (name === "GMT") return 0;
    const offset = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(name ?? "");
    if (!offset) throw new Error(`could not determine offset for ${timeZone}`);
    const [, sign, hours, minutes, seconds = "0"] = offset;
    const magnitude =
      Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
    return (sign === "-" ? -magnitude : magnitude) * 1000;
  };
  return (wall) => {
    const before = offsetAt(Math.max(-DATE_LIMIT_MS, wall - DAY_MS));
    const after = offsetAt(Math.min(DATE_LIMIT_MS, wall + DAY_MS));
    if (before === after) return wall - before;
    // [LAW:single-enforcer] Date's local-time disambiguation chooses the
    // earlier instant for a repeated time and advances across a skipped time.
    const earlier = wall - Math.max(before, after);
    return Math.abs(earlier) <= DATE_LIMIT_MS &&
      earlier + offsetAt(earlier) === wall
      ? earlier
      : wall - Math.min(before, after);
  };
}

function dateInput(
  value: unknown,
  wallTime: (wall: number) => number,
): unknown {
  if (typeof value !== "string") return value;
  const iso = ISO.exec(value);
  const { tokens, end } =
    iso === null ? legacyDate(value) : { tokens: value, end: value.length };
  const absolute =
    iso === null
      ? hasLegacyZone(tokens)
      : iso[1] === undefined || iso[2] !== undefined;
  // Parse the unzoned calendar as UTC only to recover its wall fields. The
  // recorded zone then determines which instant those fields describe.
  let instant = Date.parse(
    absolute ? value : value.slice(0, end) + (iso === null ? " GMT" : "Z"),
  );
  if (!absolute && Number.isFinite(instant)) instant = wallTime(instant);
  const date = new Date(instant);
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
  const wallTime = wallTimeIn(timeZone);
  const input = (value: unknown) => dateInput(value, wallTime);
  let longName: Intl.DateTimeFormat | undefined;
  const describe = (date: Date): string => {
    longName ??= new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "long",
    });
    const zone = longName
      .formatToParts(date)
      .find(({ type }) => type === "timeZoneName")?.value;
    const local = apply(
      SPRIG,
      "dateInZone",
      "Mon Jan 02 2006 15:04:05 GMT-0700",
      date,
      timeZone,
    );
    return `${String(local)} (${zone ?? timeZone})`;
  };
  const display = (value: unknown): Date => {
    if (!(value instanceof Date))
      throw new Error("Sprig date function did not return a Date");
    return new DisplayDate(value.getTime(), describe);
  };
  const timed = sprigDatetime(clock);
  const bind = (name: string, fn: TemplateFunc["fn"]): TemplateFunc => {
    const spec = SPRIG[name];
    if (spec === undefined)
      throw new Error(`Sprig date function unavailable: ${name}`);
    return { ...spec, fn };
  };
  const [now, ago] = DATE_CLOCK_FUNCTIONS;
  return {
    ...SPRIG,
    date: bind("date", (layout: string, value: unknown) =>
      apply(SPRIG, "dateInZone", layout, input(value), timeZone),
    ),
    dateInZone: bind(
      "dateInZone",
      (layout: string, value: unknown, zone: string) =>
        apply(SPRIG, "dateInZone", layout, input(value), zone),
    ),
    htmlDate: bind("htmlDate", (value: unknown) =>
      apply(SPRIG, "htmlDateInZone", input(value), timeZone),
    ),
    htmlDateInZone: bind("htmlDateInZone", (value: unknown, zone: string) =>
      apply(SPRIG, "htmlDateInZone", input(value), zone),
    ),
    dateModify: bind("dateModify", (duration: string, value: unknown) =>
      display(apply(SPRIG, "dateModify", duration, input(value))),
    ),
    toDate: bind("toDate", (layout: string, value: string) =>
      display(apply(SPRIG, "toDate", layout, value)),
    ),
    unixEpoch: bind("unixEpoch", (value: unknown) =>
      apply(SPRIG, "unixEpoch", input(value)),
    ),
    [now]: bind(now, () => display(clock())),
    [ago]: bind(ago, (value: unknown) => apply(timed, ago, input(value))),
  };
}
