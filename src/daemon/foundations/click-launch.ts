// The programs a click's acts launch: the bound they run under, and what a
// launch that ended badly makes of the act's outcome or of an opener's handoff.

import type { DaemonLogger } from "../../utils/logger";
import {
  failureText,
  type Failed,
  type LaunchCategory,
  type Launcher,
  type LaunchResult,
} from "../../proc/launcher";
import { DaemonClosing } from "./verb-error";
import type { EffectOutcome } from "../../renderer-interface/interface";

// [LAW:types-are-the-program] A launch a click's act makes: the program, its
// arguments and what it reads on stdin, as text, bounded by the click's own
// timeout.
export interface ClickLaunch {
  readonly bin: string;
  readonly args?: readonly string[];
  readonly stdinInput?: string;
  readonly category: LaunchCategory;
}

// How long a program a click launches has before the click fails, or, for an
// opener's handoff, before it counts as handed off: a handful of seconds at most.
export const CLICK_PROGRAM_TIMEOUT_MS = 5000;

// [LAW:no-ambient-temporal-coupling] A click's launch through `launcher`: the
// host waits out an act that ends in its turn before the click is answered, so
// the bound is no option. It is what gives the answer back.
export const clickLaunchVia =
  (launcher: Pick<Launcher, "launch">) =>
  (launch: ClickLaunch): Promise<LaunchResult> =>
    launcher.launch({
      ...launch,
      args: launch.args?.slice(),
      timeoutMs: CLICK_PROGRAM_TIMEOUT_MS,
    });

// [LAW:single-enforcer] A copy's or an open's launch, as its effect's outcome:
// rate-limited is acknowledged and logged, as `clickFailed` says below, and
// every other failure says what the launch itself said.
export function launchOutcome(
  r: LaunchResult,
  what: string,
  log: DaemonLogger,
): EffectOutcome {
  if (r.ok) return { kind: "ok" };
  if (r.reason === "rate-limited") {
    log("warn", failureText(r));
    return { kind: "ok" };
  }
  return { kind: "failed", reason: `${what} failed (${failureText(r)})` };
}

// [LAW:single-enforcer] What a click's launch that ended badly does to the
// click, for the opener's handoff (`clickHandoff`).
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
