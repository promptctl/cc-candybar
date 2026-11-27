// Write the Claude CLI process record for a test-owned foreground process.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { PROCESS_START_ENV } from "../../src/daemon/process-fingerprint";
import { writeAtomic } from "../../src/utils/atomic-write";

export function paneSessionRecord(root: string, pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw Error("missing test pane pid");
  const linux = process.platform === "linux";
  const pidDomain = linux
    ? "linux::" + readlinkSync(`/proc/${pid}/ns/pid`)
    : "darwin";
  const start = linux
    ? readFileSync(`/proc/${pid}/stat`, "utf8")
        .split(") ")
        .at(-1)!
        .split(" ")[19]!
    : execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        env: { ...process.env, ...PROCESS_START_ENV },
        encoding: "utf8",
      }).trim();
  if (!start) throw Error("missing test process start");
  const sessions = path.join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  return (sessionId: string, procStart = start) =>
    writeAtomic(
      path.join(sessions, pid + ".json"),
      JSON.stringify({
        pid,
        pidDomain,
        procStart,
        sessionId,
        kind: "interactive",
        entrypoint: "cli",
      }),
    );
}
