import os from "node:os";
import path from "node:path";

// All daemon state lives under one directory so the user can `rm -rf` it as
// a kill switch. Created lazily by whichever component needs it first.
export function daemonDir(): string {
  return path.join(os.homedir(), ".claude", "powerline");
}

export function socketPath(): string {
  return path.join(daemonDir(), "socket");
}

export function pidPath(): string {
  return path.join(daemonDir(), "pid");
}

export function logPath(): string {
  return path.join(daemonDir(), "daemon.log");
}
