// What a draw's turn record says of the faults its frame met: every error and
// warning the bar listed, each whole.
//
// [LAW:one-source-of-truth] The renderer writes the note and the host reads
// it, so both spellings live here, in the zone both processes load.

// One fault: its level, as the bar's ⚠ list shows it (an error red, a warning
// amber); its kind, the identity its producer gives it; what it is about,
// where it carries one (a slot, a variable, a placement, a file); and its
// whole message.
// [LAW:types-are-the-program] The kinds are the renderer's, which this zone
// cannot import: the renderer narrows `Kind` to the union it derives from its
// own warnings and errors, and a reader parses any kind it is handed.
export interface Fault<Kind extends string = string> {
  readonly level: "error" | "warning";
  readonly kind: Kind;
  readonly subject?: string;
  readonly message: string;
}

// A record whose frame met the same faults as the last one its session and
// renderer noted, so the record says so instead of repeating every message
// on every tick.
export const KEPT_FAULTS = "kept";

// The faults as a note spells them whole.
export const spelledFaults = (faults: readonly Fault[]): string =>
  JSON.stringify(faults);

// [LAW:single-enforcer] The one spelling of the note: the faults spelled
// whole, or `kept` while they equal the spelling `last` noted. A session's
// first note has no `last`, so it always holds the list, an empty one
// included.
export const faultsNote = (
  spelled: string,
  last: string | undefined,
): string => (last === spelled ? KEPT_FAULTS : spelled);

const LEVELS: ReadonlySet<unknown> = new Set(["error", "warning"]);
const FIELDS: ReadonlySet<string> = new Set([
  "level",
  "kind",
  "subject",
  "message",
]);

// [LAW:parse-dont-validate] A note as a record holds it, read back: `kept`,
// or the faults. Anything else is a note no renderer writes, and throws
// naming what is wrong with it.
export function readFaults(
  value: string,
): readonly Fault[] | typeof KEPT_FAULTS {
  if (value === KEPT_FAULTS) return KEPT_FAULTS;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed))
    throw new Error(`a faults note is \`kept\` or a JSON array: ${value}`);
  return parsed.map((entry: unknown, i): Fault => {
    const fault = (problem: string): Error =>
      new Error(`fault ${i} of the note ${problem}: ${value}`);
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw fault("is not an object");
    const fields = entry as Record<string, unknown>;
    const stray = Object.keys(fields).find((key) => !FIELDS.has(key));
    if (stray !== undefined) throw fault(`has a field no fault has, ${stray}`);
    const { level, kind, subject, message } = fields;
    if (!LEVELS.has(level)) throw fault("has no level of error or warning");
    if (typeof kind !== "string") throw fault("has no kind");
    if (typeof message !== "string") throw fault("has no message");
    if (subject !== undefined && typeof subject !== "string")
      throw fault("has a subject that is not text");
    return {
      level: level as Fault["level"],
      kind,
      ...(subject === undefined ? {} : { subject }),
      message,
    };
  });
}
