// What a draw's turn record says of the faults its frame met: every error and
// warning the bar listed, each whole. The same fault values accompany a
// frame when a command requests a typed inspection.
//
// [LAW:one-source-of-truth] The renderer writes the note and the host reads
// it, so both spellings live here, in the zone both processes load.

// [LAW:one-source-of-truth] Every kind of fault, and whose it is: the
// config's, when the bar the config draws is not what was drawn, so a check
// of the config fails on it; or the daemon's, what the daemon itself stands
// on, which says nothing of the config, so a check advises. The renderer's
// own warnings and errors derive the kinds it draws (src/renderer/draw-bar.ts),
// which the compiler holds to this table both ways.
export const FAULT_SCOPES = {
  "refused-args": "config",
  hints: "config",
  load: "config",
  dropped: "config",
  click: "config",
  rule: "config",
  segment: "config",
  when: "config",
  refresh: "config",
  facts: "config",
  "file-events": "daemon",
  "config-watch": "daemon",
  "repository-local-env": "daemon",
  lifeline: "daemon",
  "launch-pipes": "daemon",
  "renderer-ended": "daemon",
  "act-failed": "daemon",
} as const;

export type FaultKind = keyof typeof FAULT_SCOPES;
type KindIn<Scope> = {
  [K in FaultKind]: (typeof FAULT_SCOPES)[K] extends Scope ? K : never;
}[FaultKind];

// One fault: its level, as the bar's ⚠ list shows it (an error red, a warning
// amber); its kind, the identity its producer gives it; what it is about,
// where it carries one (a slot, a variable, a placement, a file); and its
// whole message.
export interface Fault<Kind extends FaultKind = FaultKind> {
  readonly level: "error" | "warning";
  readonly kind: Kind;
  readonly subject?: string;
  readonly message: string;
}

// [LAW:types-are-the-program] A fault as its scope reads it, so a reader
// switches over the kinds of one scope, every one of them named. The table
// read by the fault's own kind is the scope; the compiler cannot correlate an
// index with its key, so this is the one cast that says so.
export type ScopedFault =
  | { readonly scope: "config"; readonly fault: Fault<KindIn<"config">> }
  | { readonly scope: "daemon"; readonly fault: Fault<KindIn<"daemon">> };

export const scopedFault = (fault: Fault): ScopedFault =>
  ({ scope: FAULT_SCOPES[fault.kind], fault }) as ScopedFault;

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
    if (typeof kind !== "string" || !Object.hasOwn(FAULT_SCOPES, kind))
      throw fault("has no kind a fault has");
    if (typeof message !== "string") throw fault("has no message");
    if (subject !== undefined && typeof subject !== "string")
      throw fault("has a subject that is not text");
    return {
      level: level as Fault["level"],
      kind: kind as FaultKind,
      ...(subject === undefined ? {} : { subject }),
      message,
    };
  });
}
