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
  // Cap V8 old-generation at 400 MB so GC fires before RSS hits the limit
  // (RSS includes V8 heap + code-space + external; 400 MB old-gen keeps total
  // RSS well under the 512 MB hard limit). The Rust client mirrors this in
  // rust-client/src/main.rs — keep the two in sync when changing this value.
  const child = spawn(node, ["--max-old-space-size=400", script, "daemon"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}
