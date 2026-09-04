import fs from "node:fs";
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
// tmux's /tmp/tmux-<uid>/default model. UID is kernel identity: immutable,
// not overridable by any env var. /tmp is guaranteed on every Unix host and
// is cleared on reboot, which is fine — the daemon doesn't survive reboots.
// CC_CANDYBAR_SOCKET is the only explicit override for intentional isolation
// (tests, dev, multiple intentional instances).
export function socketPath(): string {
  const override = process.env.CC_CANDYBAR_SOCKET;
  if (override) return override;
  const uid = os.userInfo().uid;
  return path.join("/tmp", `cc-candybar-${uid}`, "socket");
}

// [LAW:single-enforcer] The daemon is the sole creator of the socket parent
// directory. If we enforce "this dir is uid==me + mode 0700 + not a symlink"
// at bind time, then by induction every successful bind happened under a
// trusted parent — and any client reaching the socket via the canonical path
// reached one our daemon owns. A foreign-uid or world-writable squat triggers
// a refusal, turning a silent-MITM attempt into a visible daemon failure (the
// client sees no response, the user sees the last cached render).
//
// Throws on any unsafe state; callers are expected to let the daemon exit.
// [LAW:no-silent-fallbacks] do NOT auto-rmdir + recreate — a wrong-owner dir
// is hostile state, not a recoverable error.
// [LAW:one-source-of-truth] The owner/mode/symlink verification a private
// per-uid directory needs is declared once here — both the socket parent
// (below) and the fork-bomb breaker's daemon registry dir
// (daemonRegistryDir(), fork-bomb-breaker.ts) sit under the same untrusted
// shared /tmp root and must reject the identical attack (a pre-created
// world-writable dir, a planted symlink), so they share one enforcer instead
// of two copies that could silently drift apart on what "safe" means.
export function ensureOwnedPrivateDir(dir: string): void {
  // mkdir with mode 0o700; harmless if already exists (mode is not applied
  // post-hoc — we verify it next).
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
  // Reject any group/world bits — only the owner may traverse.
  if ((st.mode & 0o077) !== 0) {
    throw new Error(
      `directory has unsafe permissions: ${dir} (mode=${(st.mode & 0o777).toString(8)}, expected 0700)`,
    );
  }
}

export function ensureSocketParentSafe(sockPath: string): void {
  const parent = path.dirname(sockPath);
  ensureOwnedPrivateDir(parent);
  // If a stale socket file is a symlink, refuse — an attacker who briefly
  // had write access to a previously-permissive dir could have planted a
  // symlink even after we tighten perms.
  //
  // [LAW:single-enforcer] The lease (`${sockPath}.lease`) gets the SAME gate:
  // it is now load-bearing (ownership authority — readLease follows a symlink
  // and a planted `lease → /dev/null` would read `absent`/`unreadable`, forcing
  // a false reclaim that unlinks a live daemon's socket). One enforcer certifies
  // every path we bind/read/write under this parent, so the socket and its lease
  // can never diverge on "is this a symlink".
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

// [LAW:one-source-of-truth] The socket-ownership lease is DERIVED FROM the
// socket path, so it shares the socket's identity root. The old diagnostic
// pidfile lived under $XDG_STATE_HOME while the socket lived under /tmp — two
// identity roots for one instance, and CC_CANDYBAR_SOCKET isolated only one of
// them. Anchoring the lease to socketPath() means test/dev isolation via
// CC_CANDYBAR_SOCKET isolates the lease too. The lease subsumes the old
// diagnostic pidfile: it carries the owner pid (the reclaim authority) plus the
// same diagnostic fields.
// [LAW:one-source-of-truth] The socket→lease derivation lives here alone, so
// leasePath() (the runtime authority path) and ensureSocketParentSafe's symlink
// gate agree by construction. Takes the socket path explicitly so the safety
// check certifies the exact path it was handed, not a re-derived one.
export function leasePathFor(sockPath: string): string {
  return `${sockPath}.lease`;
}

export function leasePath(): string {
  return leasePathFor(socketPath());
}

export function sessionStatePath(): string {
  return path.join(stateDir(), "session-state.json");
}

// [LAW:one-source-of-truth] The undo/redo history over durable config edits
// (candybar-config-dqe): whole-file snapshots of every write a click made to
// a config file (src/daemon/config-file-store.ts). Daemon-owned runtime
// state, so it sits beside session-state.json — the config files it
// snapshots are the user's, wherever discovery resolved them.
export function configEditHistoryPath(): string {
  return path.join(stateDir(), "config-edit-history.json");
}

// [LAW:one-source-of-truth] The fork-bomb breaker's daemon-population registry
// (fork-bomb-breaker.ts) shares socketPath()'s UID-anchored /tmp root and, like
// it, deliberately ignores XDG_STATE_HOME — the very isolation
// `CC_CANDYBAR_SOCKET`/`XDG_STATE_HOME` overrides grant a test daemon is the
// thing this registry exists to see THROUGH, so every daemon on this machine
// (production and every isolated instance) that does not explicitly override
// this path lands in the same directory and is counted together.
// `CC_CANDYBAR_DAEMON_REGISTRY_DIR` is the explicit override, used only by
// tests of the breaker itself so they don't contend over the machine's real
// shared registry.
export function daemonRegistryDir(): string {
  const override = process.env.CC_CANDYBAR_DAEMON_REGISTRY_DIR;
  if (override) return override;
  const uid = os.userInfo().uid;
  return path.join("/tmp", `cc-candybar-${uid}`, "daemons");
}

// [LAW:single-enforcer] Caller-side spawn dedup. Held by a client *only* during
// the spawn window — never for the daemon's lifetime. The actual one-daemon
// invariant is enforced by atomic bind() on socketPath() inside the daemon.
// This file is a thundering-herd optimization, not the load-bearing lock.
export function spawnLockPath(): string {
  return path.join(stateDir(), "spawn.lock");
}

// [LAW:one-source-of-truth] The spawn-RATE bound (as distinct from spawn.lock's
// instantaneous dedup) is anchored to one file's mtime beside spawn.lock: the
// time of the last daemon-spawn ATTEMPT. Both runtimes gate on the SAME file, so
// the filename is mirrored TS↔Rust (rust-client/src/main.rs SPAWN_COOLDOWN_FILE)
// and diffed by scripts/check-protocol.mjs — a drift would silently split the
// rate bound in two.
const SPAWN_COOLDOWN_FILE = "spawn.cooldown";
export function spawnCooldownPath(): string {
  return path.join(stateDir(), SPAWN_COOLDOWN_FILE);
}

// [LAW:one-source-of-truth] Sibling of spawn.cooldown: that file's mtime
// answers "when was a spawn last attempted"; this file's content answers
// "how many attempts in a row have failed to converge on a live daemon" —
// the consecutive-non-convergence streak that widens the cooldown window
// (see effectiveCooldownMs in acquire.ts). Same filename mirrored TS↔Rust,
// diffed by scripts/check-protocol.mjs.
const SPAWN_BACKOFF_FILE = "spawn.backoff";
export function spawnBackoffPath(): string {
  return path.join(stateDir(), SPAWN_BACKOFF_FILE);
}

// [LAW:one-source-of-truth] Where the daemon dumps each session's complete
// diagnostic text (src/daemon/diagnostic-dump.ts) so the bar's strip can
// link it as a plain `file://` URL. Daemon-owned runtime state beside
// session-state.json; wiped on daemon start like every other cold-rebuilt
// cache, so it holds only sessions that have errored since.
export function diagnosticsDir(): string {
  return path.join(stateDir(), "diagnostics");
}

export function logPath(): string {
  return path.join(stateDir(), "daemon.log");
}
