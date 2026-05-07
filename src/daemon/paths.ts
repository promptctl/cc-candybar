import os from "node:os";
import path from "node:path";

// XDG Base Directory split:
//   - daemon runtime (socket, pid, log, heap snapshots) → $XDG_STATE_HOME/cc-candybar
//   - filesystem caches (git, usage, locks, last-render) → $XDG_CACHE_HOME/cc-candybar
//
// Both default per the XDG spec ($HOME/.local/state and $HOME/.cache). Empty
// env vars fall through to the defaults. The two roots are kept separate so
// users can `rm -rf` either one without taking the other down.
//
// The Rust client mirrors this layout in rust-client/src/main.rs; both must
// agree or the client can't find the daemon's socket.

function xdgEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function stateDir(): string {
  const base =
    xdgEnv("XDG_STATE_HOME") ?? path.join(os.homedir(), ".local", "state");
  return path.join(base, "cc-candybar");
}

export function cacheDir(): string {
  const base = xdgEnv("XDG_CACHE_HOME") ?? path.join(os.homedir(), ".cache");
  return path.join(base, "cc-candybar");
}

export function configDir(): string {
  const base = xdgEnv("XDG_CONFIG_HOME") ?? path.join(os.homedir(), ".config");
  return path.join(base, "cc-candybar");
}

// `daemonDir` kept as the canonical name for the runtime root so existing
// callers (limits.ts, server.ts) don't need to learn a new term. It now
// resolves under $XDG_STATE_HOME/cc-candybar instead of ~/.claude/powerline.
export function daemonDir(): string {
  return stateDir();
}

export function socketPath(): string {
  return path.join(stateDir(), "socket");
}

export function pidPath(): string {
  return path.join(stateDir(), "pid");
}

export function logPath(): string {
  return path.join(stateDir(), "daemon.log");
}
