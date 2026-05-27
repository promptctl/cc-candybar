import os from "node:os";
import path from "node:path";

// XDG Base Directory split:
//   - daemon runtime (pid, log, heap snapshots, spawn.lock) → $XDG_STATE_HOME/cc-candybar
//   - filesystem caches (git, usage, last-render) → $XDG_CACHE_HOME/cc-candybar
//
// Both default per the XDG spec ($HOME/.local/state and $HOME/.cache). Empty
// env vars fall through to the defaults. The two roots are kept separate so
// users can `rm -rf` either one without taking the other down.
//
// The socket path is NOT derived from XDG_STATE_HOME — see socketPath() below.
// The Rust client mirrors both path families in rust-client/src/main.rs; both
// must agree or the client can't find the daemon's socket.

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

// [LAW:one-source-of-truth] The socket IS the daemon's identity — same as
// tmux's socket model. The path is independent of XDG_STATE_HOME so that
// Claude Code's per-session environment (which may set XDG_STATE_HOME to an
// isolated tmpdir) cannot silently spawn a separate daemon for each session.
// CC_CANDYBAR_SOCKET is the explicit override for intentional isolation (tests,
// dev, multiple intentional instances). No other mechanism changes this path.
export function socketPath(): string {
  const override = process.env.CC_CANDYBAR_SOCKET;
  if (override) return override;
  return path.join(os.homedir(), ".local", "state", "cc-candybar", "socket");
}

export function pidPath(): string {
  return path.join(stateDir(), "pid");
}

export function sessionStatePath(): string {
  return path.join(stateDir(), "session-state.json");
}

// [LAW:single-enforcer] Caller-side spawn dedup. Held by a client *only* during
// the spawn window — never for the daemon's lifetime. The actual one-daemon
// invariant is enforced by atomic bind() on socketPath() inside the daemon.
// This file is a thundering-herd optimization, not the load-bearing lock.
export function spawnLockPath(): string {
  return path.join(stateDir(), "spawn.lock");
}

export function logPath(): string {
  return path.join(stateDir(), "daemon.log");
}
