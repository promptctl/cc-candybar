import fs from "node:fs";
import path from "node:path";
import type { Host } from "../host.js";
import type { StoredRoot } from "./foundations/stored-path";
import { onDiskDirectory } from "../utils/on-disk-path";
import {
  HOME_CACHE_DIR,
  HOME_ENV,
  HOME_CONFIG_DIR,
  HOME_STATE_DIR,
  MAIN_SOCKET_FILE,
  NAME_ENV,
  RUNTIME_DIR_ENV,
  socketFile,
  uidRuntimeDir,
  xdgEnv,
  type RendererHome,
} from "./home";

// Every path a renderer uses is a function of its home (home.ts), spelled
// here alone. The main home's derivations are the XDG Base Directory split:
//   - daemon runtime (log, heap snapshots, spawn.lock) → $XDG_STATE_HOME/cc-candybar
//   - filesystem caches (git, usage, last-render) → $XDG_CACHE_HOME/cc-candybar
//   - the user's config → $XDG_CONFIG_HOME/cc-candybar
// A named home has `state/`, `cache/` and `config/` beneath its root. Its
// socket is not under the root: it sits beside main's in the per-uid runtime
// directory, because a link carries a name and nothing else.
//
// The Rust client mirrors the socket, state and cache rules in
// rust-client/src/main.rs; both must agree or the client can't find the
// daemon's socket.

// [LAW:dataflow-not-control-flow] Each derivation is one function over the
// union with its two arms side by side; nothing downstream asks which it has.
// [LAW:effects-at-boundaries] The home is a parameter with no default, so a
// spawner holding a daemon's home (a test fixture) can name that daemon's
// files — its log above all — without a second derivation of this layout.
export function stateDir(home: RendererHome): string {
  return home.kind === "main"
    ? path.join(home.roots.state, "cc-candybar")
    : path.join(home.root, HOME_STATE_DIR);
}

export function cacheDir(home: RendererHome): string {
  return home.kind === "main"
    ? path.join(home.roots.cache, "cc-candybar")
    : path.join(home.root, HOME_CACHE_DIR);
}

// Where the home's config file lives (`config.json5` beneath it): the user's
// own layer, the bottom of every chain (src/config/loader/discovery.ts).
export function configDir(home: RendererHome): string {
  return home.kind === "main"
    ? path.join(home.roots.config, "cc-candybar")
    : path.join(home.root, HOME_CONFIG_DIR);
}

// [LAW:one-source-of-truth] The directory a stored home path is relative to
// (stored-path.ts): a named home's root, which holds its whole tree; main's
// config directory, the one place a file its clicks write lies. Main's XDG
// tree has no root to move with, and its state and cache hold no stored path.
export function storedRoot(home: RendererHome): StoredRoot {
  return storedRootAt(home.kind === "main" ? configDir(home) : home.root);
}

// [LAW:effects-at-boundaries] The disk's spelling is bound here, where every
// stored root is made; nothing reads it until a stored path is decided.
export function storedRootAt(dir: string): StoredRoot {
  return { dir, onDisk: onDiskDirectory };
}

// [LAW:one-source-of-truth] The socket IS the renderer's identity on the wire:
// its file is the name's (home.ts), in the per-uid runtime directory.
export function socketPath(home: RendererHome): string {
  return home.kind === "main" && home.legacySocket !== null
    ? home.legacySocket
    : path.join(home.runtime, socketFile(home.name));
}

// The socket a process with no environment reaches — the URL handler app's,
// which Launch Services starts without this shell's environment.
export function defaultSocketPath(): string {
  return path.join(uidRuntimeDir(), MAIN_SOCKET_FILE);
}

// [LAW:one-source-of-truth] The environment a child this renderer starts (a
// bar pane, the tmux status row's click handler) is given so that it parses
// the identical home: every variable a home is read from, stated as the home
// holds it — its inputs, never a derivation — and those that do not apply
// stated empty, which reads as unset, so a value the tmux server's or the
// spawning shell's environment carries never reaches the child. A canonical
// main's child is a canonical main; one on the legacy override passes the
// override through, so the one-release warning finds only the shell that set
// it. [LAW:no-mode-explosion] exception: the socket entry is the bridge; the
// ticket retiring it deletes that entry and nothing else here.
export function homeEnv(home: RendererHome): Readonly<Record<string, string>> {
  return home.kind === "main"
    ? {
        [HOME_ENV]: "",
        [NAME_ENV]: "",
        [RUNTIME_DIR_ENV]: home.runtime,
        // The resolved roots: the child under the tmux server's environment
        // derives this renderer's state, cache and config, not the server's.
        XDG_STATE_HOME: home.roots.state,
        XDG_CACHE_HOME: home.roots.cache,
        XDG_CONFIG_HOME: home.roots.config,
        CC_CANDYBAR_SOCKET: home.legacySocket ?? "",
      }
    : {
        [HOME_ENV]: home.root,
        [NAME_ENV]: home.name,
        [RUNTIME_DIR_ENV]: home.runtime,
        CC_CANDYBAR_SOCKET: "",
      };
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
// [LAW:no-silent-failure] do NOT auto-rmdir + recreate — a wrong-owner dir
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
  // The kernel's uid, as the runtime directory's name reads it (home.ts).
  const myUid = process.getuid!();
  if (st.uid !== myUid) {
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

// The runtime directory is shared by every home, so the first renderer bound
// under it, main's or a named one's, is the one that creates it.
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
// socket path, so it shares the socket's identity root: a home's socket and
// its lease sit side by side in the runtime directory. The lease carries the
// owner pid (the reclaim authority) plus the diagnostic fields the old pidfile
// held.
// [LAW:one-source-of-truth] The socket→lease derivation lives here alone, so
// leasePath() (the runtime authority path) and ensureSocketParentSafe's symlink
// gate agree by construction. Takes the socket path explicitly so the safety
// check certifies the exact path it was handed, not a re-derived one.
export function leasePathFor(sockPath: string): string {
  return `${sockPath}.lease`;
}

export function leasePath(home: RendererHome): string {
  return leasePathFor(socketPath(home));
}

export function sessionStatePath(home: RendererHome): string {
  return path.join(stateDir(home), "session-state.json");
}

// [LAW:one-source-of-truth] Each session's undo/redo history over every
// settings change it made (src/daemon/settings-history.ts). Daemon-owned
// runtime state, so it sits beside session-state.json — the config files its
// steps snapshot are the user's, wherever discovery resolved them.
export function settingsHistoryPath(home: RendererHome): string {
  return path.join(stateDir(home), "settings-history.json");
}

// [LAW:one-source-of-truth] The fork-bomb breaker's daemon-population registry
// (fork-bomb-breaker.ts) is not a derivation of any home: it sits in the
// machine's UID-anchored /tmp root and ignores the runtime directory override
// too, because the isolation a home grants a test daemon is the very thing this
// registry exists to see THROUGH, so every daemon on this machine (the main
// one and every named one) that does not explicitly override this path lands
// in the same directory and is counted together.
// `CC_CANDYBAR_DAEMON_REGISTRY_DIR` is the explicit override, used only by
// tests of the breaker itself so they don't contend over the machine's real
// shared registry.
export function daemonRegistryDir(host: Host): string {
  const override = host.env.CC_CANDYBAR_DAEMON_REGISTRY_DIR;
  if (override) return override;
  return path.join(uidRuntimeDir(), "daemons");
}

// [LAW:single-enforcer] Caller-side spawn dedup. Held by a client *only* during
// the spawn window — never for the daemon's lifetime. The actual one-daemon
// invariant is enforced by atomic bind() on socketPath() inside the daemon.
// This file is a thundering-herd optimization, not the load-bearing lock.
export function spawnLockPath(home: RendererHome): string {
  return path.join(stateDir(home), "spawn.lock");
}

// [LAW:one-source-of-truth] The spawn-RATE bound (as distinct from spawn.lock's
// instantaneous dedup) is anchored to one file's mtime beside spawn.lock: the
// time of the last daemon-spawn ATTEMPT. Both runtimes gate on the SAME file, so
// the filename is mirrored TS↔Rust (rust-client/src/main.rs SPAWN_COOLDOWN_FILE)
// and diffed by scripts/check-protocol.mjs — a drift would silently split the
// rate bound in two.
const SPAWN_COOLDOWN_FILE = "spawn.cooldown";
export function spawnCooldownPath(home: RendererHome): string {
  return path.join(stateDir(home), SPAWN_COOLDOWN_FILE);
}

// [LAW:one-source-of-truth] Sibling of spawn.cooldown: that file's mtime
// answers "when was a spawn last attempted"; this file's content answers
// "how many attempts in a row have failed to converge on a live daemon" —
// the consecutive-non-convergence streak that widens the cooldown window
// (see effectiveCooldownMs in acquire.ts). Same filename mirrored TS↔Rust,
// diffed by scripts/check-protocol.mjs.
const SPAWN_BACKOFF_FILE = "spawn.backoff";
export function spawnBackoffPath(home: RendererHome): string {
  return path.join(stateDir(home), SPAWN_BACKOFF_FILE);
}

// The daemon's own folder for testing its file watch: never the state
// directory itself, where the log writes on every request.
export function watchProbeDir(home: RendererHome): string {
  return path.join(stateDir(home), "watch-probe");
}

export function logPath(home: RendererHome): string {
  return path.join(stateDir(home), "daemon.log");
}

// [LAW:effects-at-boundaries] Every path a daemon process touches, derived
// from its home and handed down as a value: the daemon's modules take the one
// they write to, so a daemon under a home writes nowhere else. The process's
// entry and the daemon it hands the home to each derive it, by this one
// function over the one home, so the two cannot differ.
// [LAW:one-source-of-truth] Each member is the accessor above of the same name,
// so the layout is still derived in this file alone.
export interface DaemonPaths {
  readonly socket: string;
  readonly lease: string;
  readonly state: string;
  readonly log: string;
  readonly sessionState: string;
  readonly settingsHistory: string;
  readonly storedRoot: StoredRoot;
  readonly watchProbe: string;
  readonly spawnBackoff: string;
}

export function daemonPaths(home: RendererHome): DaemonPaths {
  return {
    socket: socketPath(home),
    lease: leasePath(home),
    state: stateDir(home),
    log: logPath(home),
    sessionState: sessionStatePath(home),
    settingsHistory: settingsHistoryPath(home),
    storedRoot: storedRoot(home),
    watchProbe: watchProbeDir(home),
    spawnBackoff: spawnBackoffPath(home),
  };
}

// [LAW:one-source-of-truth] Where the home's config and the user's installed
// plugins live: the one record the config loader, the plugin installer and the
// doctor share. The config directory is the home's (`configDir`); the plugin
// data directories are the host's, because plugins are the user's, not a
// renderer's, and an empty `XDG_DATA_HOME` means the default in all of them.
// Pure over the host and the home, parsed once by the root and handed down.
export interface Locations {
  readonly homeDir: string;
  readonly configDir: string;
  readonly dataHome: string;
  // Most-preferred first, as `XDG_DATA_DIRS` orders them.
  readonly dataDirs: readonly string[];
}

// The user's data home: where installed plugins and, on Linux, the staged
// runtime live.
export function dataHome(host: Host): string {
  return (
    xdgEnv(host.env, "XDG_DATA_HOME") ?? path.join(host.home, ".local", "share")
  );
}

export function locations(host: Host, home: RendererHome): Locations {
  const { env } = host;
  // The XDG default, and on macOS Homebrew's share/ first: Apple-silicon
  // Homebrew lives outside `/usr/local` (`$HOMEBREW_PREFIX`, set by its
  // shellenv, else its default `/opt/homebrew`).
  const xdgDefault = "/usr/local/share:/usr/share";
  const defaultDataDirs =
    process.platform === "darwin"
      ? `${path.join(xdgEnv(env, "HOMEBREW_PREFIX") ?? "/opt/homebrew", "share")}:${xdgDefault}`
      : xdgDefault;
  return {
    homeDir: host.home,
    configDir: configDir(home),
    dataHome: dataHome(host),
    dataDirs: (xdgEnv(env, "XDG_DATA_DIRS") ?? defaultDataDirs)
      .split(":")
      .filter((d) => d !== ""),
  };
}
