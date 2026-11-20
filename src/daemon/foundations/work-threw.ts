// [LAW:no-silent-failure] Where work the daemon calls, with no caller to
// answer for it, reports that it threw: the event, the fields that name what
// threw, and the thrown value.
import { eventLine, type Field } from "../../utils/logfmt.js";
import type { DaemonLogger } from "../../utils/logger.js";
import { failureOf } from "./verb-error.js";

export type WorkThrew = (
  event: string,
  fields: readonly Field[],
  thrown: unknown,
) => void;

// [LAW:one-source-of-truth] The one record of a throw, for the log and for
// whatever shows it.
export const threwLine = (
  event: string,
  fields: readonly Field[],
  thrown: unknown,
): string =>
  eventLine(event, [...fields, ["failed", failureOf(thrown).detail]]);

// Outside the daemon there is no bar to hold a throw, so its consumer's
// logger is where it goes.
export const loggedThrew =
  (logger: DaemonLogger): WorkThrew =>
  (event, fields, thrown) =>
    logger("error", threwLine(event, fields, thrown));
