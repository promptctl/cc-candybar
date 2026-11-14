// [LAW:effects-at-boundaries] A click's handoff of a URL to the platform's
// opener, run as a job the daemon's close does not reach.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { readJobEnd } from "../proc/launch";
import type { LaunchOpts, Launcher } from "../proc/launcher";
import { sleep } from "../time";
import { clickFailed } from "./foundations/click-launch";
import type { DaemonLogger } from "../utils/logger";

// How often a handoff looks for its opener's verdict while the click waits.
const HANDOFF_POLL_MS = 50;

// [LAW:one-type-per-behavior] A click that hands a URL to the platform's
// opener. Unlike `clickLaunch`, what the opener starts must outlive the click:
// xdg-open with no browser running stays the browser's parent, so a launch the
// bound ends would end the browser with it. The opener runs as a job, whose
// group nothing aimed at the daemon reaches — a closing daemon included — and
// the click waits on its verdict for `boundMs`. [LAW:no-silent-failure] An
// opener that exits non-zero inside the bound fails the click with what it
// wrote to stderr, and a job whose group is gone with no verdict was lost; one
// still running at the bound has handed off, and is left running.
export async function clickHandoff(
  launcher: Launcher,
  opts: Omit<LaunchOpts, "timeoutMs">,
  what: string,
  log: DaemonLogger,
  boundMs: number,
  tmp: string,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmp, "cc-candybar-handoff-"));
  // The job's files go when the click is answered: a program still running
  // keeps the descriptors it already holds, and its sh's verdict, written to a
  // directory that is gone, has no reader left to miss it.
  try {
    const files = {
      // Unread, and a handed-off browser would write to it for its whole life.
      stdout: "/dev/null",
      stderr: path.join(dir, "stderr"),
      status: path.join(dir, "status"),
    };
    const job = launcher.launchJobSync(opts, files);
    if (!job.ok) {
      clickFailed(
        { ...job, stdout: "", stderr: "", exitCode: null, signal: null },
        what,
        log,
      );
      return;
    }
    job.release();
    // [LAW:no-ambient-temporal-coupling] A monotonic clock, so a wall-clock
    // step neither stretches nor cuts the bound.
    const deadline = launcher.clock.monotonic() + boundMs;
    for (;;) {
      // Liveness before the verdict: the sh writes its verdict before it exits,
      // so a group seen gone and then no verdict means none is coming.
      const alive = launcher.jobGroupAlive(job.pid);
      const end = readJobEnd(files.status);
      if (end !== null) {
        if (end.kind === "exit" && end.code === 0) return;
        clickFailed(
          end.kind === "exit"
            ? {
                ok: false,
                reason: "non-zero",
                stdout: "",
                stderr: readFileSync(files.stderr, "utf8"),
                exitCode: end.code,
                signal: null,
              }
            : {
                ok: false,
                reason: "timeout",
                stdout: "",
                stderr: "",
                exitCode: null,
                signal: null,
              },
          what,
          log,
        );
        return;
      }
      if (!alive)
        throw new Error(
          `${what} failed (lost): the opener ended with no verdict`,
        );
      if (launcher.clock.monotonic() >= deadline) {
        // [LAW:nothing-unseen] What the click leaves running is said once.
        log(
          "info",
          `${opts.category} handed off at ${boundMs}ms, pid ${job.pid}`,
        );
        return;
      }
      await sleep(launcher.clock, HANDOFF_POLL_MS);
    }
  } finally {
    // A sh writing its verdict as the click is answered can add a file between
    // the listing and the rmdir; the retry takes it with the rest.
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
