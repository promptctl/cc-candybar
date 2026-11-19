// What a turn's record says of the doctor run it judged: every check's
// verdict, whole, so a reader of the record (`cc-candybar doctor`) prints the
// report the bar's rows were written from, never a second judgement of its own.
//
// [LAW:one-source-of-truth] The renderer writes the note and the host reads
// it, so both spellings live here, in the zone both processes load.

import type { RunName } from "../doctor/gather";

// The field the note rides in.
export const DOCTOR_NOTE = "doctor";

// [LAW:types-are-the-program] One check's verdict as the record carries it:
// ok, with what the check could not judge where it says so; or failed, with
// every problem it found, whether the bar can fix it, and the glyphs it asks
// the user to look at.
export type NotedVerdict =
  | { readonly ok: true; readonly note?: string }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly more: readonly string[];
      readonly fixable: boolean;
      readonly look?: string;
    };

export interface NotedReport {
  readonly name: string;
  readonly label: string;
  readonly verdict: NotedVerdict;
}

// [LAW:no-silent-failure] How a run ended: its reports, or why there are
// none, so a reader waiting on the note hears a failed run as one. Either
// names its run, as the click that asked it and the host's read of it do.
export type NotedRun = { readonly run: RunName } & (
  | { readonly kind: "reported"; readonly reports: readonly NotedReport[] }
  | { readonly kind: "failed"; readonly reason: string }
);

export const doctorNote = (run: NotedRun): string => JSON.stringify(run);

const text = (v: unknown): v is string => typeof v === "string";

// [LAW:parse-dont-validate] A note as a record holds it, read back. Anything
// else is a note no renderer writes, and throws naming what is wrong with it.
export function readDoctorNote(value: string): NotedRun {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null)
    throw new Error(`a doctor note is a JSON object: ${value}`);
  const run = parsed as Record<string, unknown>;
  if (run.kind === "failed") {
    if (!text(run.reason))
      throw new Error(`a failed run has no reason: ${value}`);
    return { run: runOf(run.run, value), kind: "failed", reason: run.reason };
  }
  if (run.kind !== "reported")
    throw new Error(`a doctor note is neither reported nor failed: ${value}`);
  if (!Array.isArray(run.reports))
    throw new Error(`a reported run's reports are not a JSON array: ${value}`);
  return {
    run: runOf(run.run, value),
    kind: "reported",
    reports: readReports(run.reports, value),
  };
}

// The run a note names, as the renderer that wrote it minted it.
function runOf(run: unknown, value: string): RunName {
  if (!Number.isSafeInteger(run))
    throw new Error(`a doctor note names no run: ${value}`);
  return run as RunName;
}

function readReports(
  parsed: readonly unknown[],
  value: string,
): readonly NotedReport[] {
  return parsed.map((entry: unknown, i): NotedReport => {
    const bad = (problem: string): Error =>
      new Error(`report ${i} of the doctor note ${problem}: ${value}`);
    if (typeof entry !== "object" || entry === null)
      throw bad("is not an object");
    const { name, label, verdict } = entry as Record<string, unknown>;
    if (!text(name) || !text(label)) throw bad("has no name or label");
    if (typeof verdict !== "object" || verdict === null)
      throw bad("has no verdict");
    const v = verdict as Record<string, unknown>;
    if (v.ok === true) {
      if (v.note !== undefined && !text(v.note))
        throw bad("has a note that is not text");
      return {
        name,
        label,
        verdict: {
          ok: true,
          ...(v.note === undefined ? {} : { note: v.note }),
        },
      };
    }
    if (v.ok !== false) throw bad("has a verdict neither ok nor failed");
    const { reason, more, fixable, look } = v;
    if (!text(reason)) throw bad("has no reason");
    if (!Array.isArray(more) || !more.every(text))
      throw bad("has no list of further problems");
    if (typeof fixable !== "boolean")
      throw bad("does not say if it is fixable");
    if (look !== undefined && !text(look))
      throw bad("has glyphs to look at that are not text");
    return {
      name,
      label,
      verdict: {
        ok: false,
        reason,
        more,
        fixable,
        ...(look === undefined ? {} : { look }),
      },
    };
  });
}
