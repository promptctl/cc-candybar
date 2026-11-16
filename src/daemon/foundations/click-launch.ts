// What a click's launch that ended badly does to its act, and the bound its
// programs run under: shared by the acts that launch and the host's handoff.

import type { DaemonLogger } from "../../utils/logger";
import {
  failureText,
  type Failed,
  type LaunchCategory,
  type Launcher,
  type LaunchResult,
} from "../../proc/launcher";
import { DaemonClosing } from "./verb-error";

// [LAW:types-are-the-program] A launch a click's act makes: the program, its
// arguments and what it reads on stdin, as text.
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
// click is answered only once its act has ended, so the bound is no option.
// It is what lets the click be answered.
export const clickLaunchVia =
  (launcher: Pick<Launcher, "launch">) =>
  (launch: ClickLaunch): Promise<LaunchResult> =>
    launcher.launch({
      ...launch,
      args: launch.args?.slice(),
      timeoutMs: CLICK_PROGRAM_TIMEOUT_MS,
    });

// [LAW:one-type-per-behavior] A click's launch of a program it waits out —
// the clipboard, an editor — each of which hands off and exits.
export async function clickLaunch(
  launch: (launch: ClickLaunch) => Promise<LaunchResult>,
  opts: ClickLaunch,
  what: string,
  log: DaemonLogger,
): Promise<void> {
  const result = await launch(opts);
  if (!result.ok) clickFailed(result, what, log);
}

// [LAW:single-enforcer] What a click's launch that ended badly does to the
// act, for both of the launches a click makes (`clickLaunch`, `clickHandoff`).
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
