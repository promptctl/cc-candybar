import {
  DateTimeFormat,
  gregorianFields,
  zoneOffsetMilliseconds,
} from "@formatjs/intl-datetimeformat";
import { loadEnglish } from "@formatjs/intl-datetimeformat/locale-data/en.js";
import { loadTimeZones } from "@formatjs/intl-datetimeformat/add-all-tz.js";

// [LAW:carrying-cost] CLI commands without a calendar pay no data initialization.
let registered = false;

const DAY_MS = 86_400_000;
const DATE_LIMIT_MS = 8.64e15;

// [LAW:effects-at-boundaries] Read offsets only at supplied instants in the
// supplied zone. Native Date never interprets an unzoned timestamp itself.
export class ZonedCalendar {
  private readonly shortName: InstanceType<typeof DateTimeFormat>;
  private longName?: InstanceType<typeof DateTimeFormat>;

  constructor(private readonly timeZone: string) {
    if (!registered) {
      loadEnglish();
      loadTimeZones();
      registered = true;
    }
    this.shortName = new DateTimeFormat("en", {
      timeZone,
      timeZoneName: "short",
    });
  }

  private offsetAt(instant: number): number {
    return zoneOffsetMilliseconds(this.shortName, instant);
  }

  nameAt(date: Date, width: "long" | "short"): string {
    const formatter =
      width === "short"
        ? this.shortName
        : (this.longName ??= new DateTimeFormat("en", {
            timeZone: this.timeZone,
            timeZoneName: "long",
          }));
    const name = formatter
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value;
    if (name === undefined)
      throw new Error(`No ${width} time-zone name for ${this.timeZone}`);
    return name;
  }

  partsAt(date: Date) {
    const fields = gregorianFields(this.shortName, date.getTime());
    return {
      ...fields,
      hour12: fields.hour % 12 || 12,
      tzAbbr: this.nameAt(date, "short"),
    };
  }

  instantOfWallTime(wall: number): number {
    const before = this.offsetAt(Math.max(-DATE_LIMIT_MS, wall - DAY_MS));
    const after = this.offsetAt(Math.min(DATE_LIMIT_MS, wall + DAY_MS));
    if (before === after) return wall - before;
    // [LAW:single-enforcer] Date's local-time disambiguation chooses the
    // earlier instant for a repeated time and advances across a skipped time.
    const earlier = wall - Math.max(before, after);
    return Math.abs(earlier) <= DATE_LIMIT_MS &&
      earlier + this.offsetAt(earlier) === wall
      ? earlier
      : wall - Math.min(before, after);
  }

  // [LAW:one-source-of-truth] Gregorian fields in the host's recorded zone
  // are the same keys in the ledger and the draw, independently of display locale.
  dayKey(date: Date): string {
    const { year, month, day } = gregorianFields(
      this.shortName,
      date.getTime(),
    );
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  previousMidnight(now: number): number {
    const wallDay = Math.floor((now + this.offsetAt(now)) / DAY_MS);
    return this.instantOfWallTime((wallDay - 1) * DAY_MS);
  }
}
