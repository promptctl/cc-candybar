import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OneShotLauncher } from "../proc/launch";
import {
  processAlive,
  readStartTimeSync,
  sameProcess,
} from "../daemon/process-fingerprint";

// [LAW:no-ambient-temporal-coupling] Publish a unique claim before listing
// other installers. Two contenders may both refuse, but they cannot both
// enter: the first one to scan is already visible to the second. A dead
// owner's name never gets reused, so two peers reclaiming it cannot remove
// a newer install's claim. The kernel's start time distinguishes reused PIDs.
const CLAIM =
  /^\.cc-candybar-install\.(\d+)\.([A-Za-z0-9_-]+)\.[0-9a-f-]{36}\.lock$/;

export function withInstallClaim<T>(
  home: string,
  launcher: Pick<OneShotLauncher, "launchSync">,
  install: () => T,
): T {
  const started = readStartTimeSync(process.pid, (opts) =>
    launcher.launchSync(opts),
  );
  if (started.kind === "unavailable")
    throw new Error(`cannot identify the installer: ${started.detail}`);
  const token = Buffer.from(started.token).toString("base64url");
  const mine = `.cc-candybar-install.${process.pid}.${token}.${randomUUID()}.lock`;
  const file = path.join(home, mine);
  fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
  try {
    for (const name of fs.readdirSync(home)) {
      if (name === mine) continue;
      const match = CLAIM.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      const claim = path.join(home, name);
      if (processAlive(pid)) {
        const read =
          pid === process.pid
            ? started
            : readStartTimeSync(pid, (opts) => launcher.launchSync(opts));
        const recorded = Buffer.from(match[2]!, "base64url").toString("utf8");
        if (
          read.kind === "unavailable" ||
          sameProcess(
            { pid, startTime: recorded },
            { pid, startTime: read.token },
          ) === "same"
        )
          throw new Error(
            `Another install holds ${claim} (pid ${pid}). Retry after it finishes.`,
          );
      }
      fs.rmSync(claim, { force: true });
    }
    return install();
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      process.stderr.write(
        `install: could not release ${file}: ${String(error)}\n`,
      );
    }
  }
}
