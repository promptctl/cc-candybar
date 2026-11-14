// What a click's launch that ended badly does to the click, and the bound its
// programs run under: shared, because the renderer's verbs launch and the host
// hands off.

import type { DaemonLogger } from "../../utils/logger";
import { failureText, type Failed } from "../../proc/launcher";
import { DaemonClosing } from "./verb-error";

// How long a program a click launches has before the click fails, or, for an
// opener's handoff, before it counts as handed off: a handful of seconds at most.
export const CLICK_PROGRAM_TIMEOUT_MS = 5000;

// [LAW:single-enforcer] What a click's launch that ended badly does to the
// click, for both of the launches a click makes (`clickLaunch`, `clickHandoff`).
// [LAW:dataflow-not-control-flow] Rate-limit rejection is one outcome among
// many — the click is acknowledged and the rejection is logged. A closing
// daemon is its own outcome; every other failure surfaces as RENDER_FAILED,
// saying what the launch itself said: the spawn's error, or the program's stderr.
export function clickFailed(r: Failed, what: string, log: DaemonLogger): void {
  if (r.reason === "rate-limited") {
    log("warn", failureText(r));
    return;
  }
  if (r.reason === "aborted") throw new DaemonClosing(what);
  throw new Error(`${what} failed (${failureText(r)})`);
}
