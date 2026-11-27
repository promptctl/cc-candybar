// The bounded launches an awaited clipboard or editor act makes.

import {
  failureText,
  type LaunchCategory,
  type ContextualLauncher,
  type LaunchResult,
} from "../../proc/launcher";
import { DaemonClosing } from "./verb-error";
import type { EffectOutcome } from "../../renderer-interface/interface";

// [LAW:types-are-the-program] A launch a click's act makes: the program, its
// arguments and what it reads on stdin, as text.
export interface ClickLaunch {
  readonly bin: string;
  readonly args?: readonly string[];
  readonly stdinInput?: string;
  readonly category: LaunchCategory;
}

// How long an awaited click program has before its effect fails.
export const CLICK_PROGRAM_TIMEOUT_MS = 5000;

// [LAW:no-ambient-temporal-coupling] A click's launch through `launcher`: the
// click is answered only once its act has ended, so the bound is no option.
// It is what lets the click be answered.
export const clickLaunchVia =
  (launcher: ContextualLauncher) =>
  (launch: ClickLaunch): Promise<LaunchResult> =>
    launcher.launch({
      ...launch,
      args: launch.args?.slice(),
      timeoutMs: CLICK_PROGRAM_TIMEOUT_MS,
    });

// [LAW:one-type-per-behavior] These launches either finish, fail to perform
// the requested action, or end with the daemon. A rate limit is a failure of
// the launch itself, so it uses the same settlement and warnings as a timeout.
type ClickLaunchOutcome = Extract<
  EffectOutcome,
  { readonly kind: "ok" | "failed" | "closing" }
>;

export async function clickLaunch(
  launch: (launch: ClickLaunch) => Promise<LaunchResult>,
  opts: ClickLaunch,
  what: string,
  said: string,
): Promise<{ readonly outcome: ClickLaunchOutcome; readonly said: string }> {
  const result = await launch(opts);
  if (result.ok) return { outcome: { kind: "ok" }, said };
  if (result.reason === "aborted") {
    const reason = new DaemonClosing(what).message;
    return { outcome: { kind: "closing", reason }, said: reason };
  }
  const reason =
    result.reason === "rate-limited"
      ? `${what} not run: ${failureText(result)}`
      : `${what} failed (${failureText(result)})`;
  return { outcome: { kind: "failed", reason }, said: reason };
}
