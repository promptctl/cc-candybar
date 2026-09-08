import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Runtime state and caches are separate XDG roots so either can be cleared alone.
// The socket path is NOT derived from XDG_STATE_HOME — see socketPath() below. The
// Rust client mirrors both families; they must agree or it cannot find the socket.

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

export function daemonDir(): string {
  return stateDir();
}

// [LAW:one-source-of-truth] The socket IS the daemon's identity, anchored to the UID
// because that is kernel identity, overridable by nothing but CC_CANDYBAR_SOCKET.
export function socketPath(): string {
  const override = process.env.CC_CANDYBAR_SOCKET;
  if (override) return override;
  const uid = os.userInfo().uid;
  return path.join("/tmp", `cc-candybar-${uid}`, "socket");
}

// [LAW:single-enforcer] Enforced at bind time, so by induction every successful bind
// happened under a trusted parent. [LAW:no-silent-fallbacks] Never auto-rmdir and
// recreate — a wrong-owner dir is hostile state, not a recoverable error.
export function ensureOwnedPrivateDir(dir: string): void {
  // mode is not applied to an existing dir, hence the verification below.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) {
    throw new Error(`directory is a symlink: ${dir}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`not a directory: ${dir}`);
  }
  const myUid = os.userInfo().uid;
  // getuid is undefined on Windows; we don't ship there, but guard cheaply.
  if (typeof myUid === "number" && st.uid !== myUid) {
    throw new Error(
      `directory is not owned by uid ${myUid}: ${dir} (owner uid=${st.uid})`,
    );
  }
  if ((st.mode & 0o077) !== 0) {
    throw new Error(
      `directory has unsafe permissions: ${dir} (mode=${(st.mode & 0o777).toString(8)}, expected 0700)`,
    );
  }
}

export function ensureSocketParentSafe(sockPath: string): void {
  const parent = path.dirname(sockPath);
  ensureOwnedPrivateDir(parent);
  // [LAW:single-enforcer] The lease gets the SAME symlink gate as the socket: a
  // planted `lease → /dev/null` reads absent and forces a false reclaim.
  for (const p of [sockPath, leasePathFor(sockPath)]) {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) {
        throw new Error(`path is a symlink: ${p}`);
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw e;
    }
  }
}

// [LAW:one-source-of-truth] The lease is DERIVED from the socket path, so it shares
// one identity root and CC_CANDYBAR_SOCKET isolates both. Takes that path explicitly
// so the safety check certifies the exact path it was handed, not a re-derived one.
export function leasePathFor(sockPath: string): string {
  return `${sockPath}.lease`;
}

export function leasePath(): string {
  return leasePathFor(socketPath());
}

export function sessionStatePath(): string {
  return path.join(stateDir(), "session-state.json");
}

export function configEditHistoryPath(): string {
  return path.join(stateDir(), "config-edit-history.json");
}

// [LAW:one-source-of-truth] Deliberately ignores XDG_STATE_HOME: the isolation those
// overrides grant is exactly what this population count must see THROUGH.
export function daemonRegistryDir(): string {
  const override = process.env.CC_CANDYBAR_DAEMON_REGISTRY_DIR;
  if (override) return override;
  const uid = os.userInfo().uid;
  return path.join("/tmp", `cc-candybar-${uid}`, "daemons");
}

// [LAW:single-enforcer] A thundering-herd optimization, not the load-bearing lock: the one-daemon invariant is atomic bind().
export function spawnLockPath(): string {
  return path.join(stateDir(), "spawn.lock");
}

// [LAW:one-source-of-truth] The spawn-RATE bound is this file's mtime; the name is mirrored TS↔Rust or the bound splits in two.
const SPAWN_COOLDOWN_FILE = "spawn.cooldown";
export function spawnCooldownPath(): string {
  return path.join(stateDir(), SPAWN_COOLDOWN_FILE);
}

// [LAW:one-source-of-truth] The non-convergence streak that widens the cooldown; mirrored TS↔Rust like its sibling.
const SPAWN_BACKOFF_FILE = "spawn.backoff";
export function spawnBackoffPath(): string {
  return path.join(stateDir(), SPAWN_BACKOFF_FILE);
}

export function diagnosticsDir(): string {
  return path.join(stateDir(), "diagnostics");
}

export function logPath(): string {
  return path.join(stateDir(), "daemon.log");
}
