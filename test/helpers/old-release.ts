import { OWNER_CONTEXT } from "../../src/proc/launcher.js";
import { processLauncher } from "./host";

// [LAW:one-source-of-truth] How a release before tokens could be spelled any
// other way read a process's start time: `ps -o lstart=` under C locale and
// UTC, trimmed, compared by raw equality against the token a record holds.
// Spelled out here rather than reached through the module, so a change to how
// the module spells a token is checked against what older daemons still read.
export async function oldReleaseStartTime(pid: number): Promise<string> {
  const res = await processLauncher.launch({ ...OWNER_CONTEXT,
    bin: "ps",
    args: ["-o", "lstart=", "-p", String(pid)],
    category: "process-fingerprint",
    timeoutMs: 2000,
    envOverlay: { LC_ALL: "C", TZ: "UTC" },
  });
  if (!res.ok) throw new Error(`ps could not read pid ${pid}: ${res.reason}`);
  return res.stdout.trim();
}
