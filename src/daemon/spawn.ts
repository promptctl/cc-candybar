import { spawn } from "node:child_process";
import process from "node:process";

// Detached daemon spawn. Caller does not wait. We don't try to verify the
// daemon actually came up — the *next* client request will either succeed
// (great) or fall through to inline + spawn another (also fine; the pidfile
// mutex serializes them).
export function spawnDaemonDetached(): void {
  const node = process.execPath;
  const script = process.argv[1];
  if (!script) return;
  const child = spawn(node, [script, "daemon"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}
