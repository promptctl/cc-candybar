import path from "node:path";
import type { Host } from "../host.js";

// [LAW:one-source-of-truth] A renderer has one identity, its home, and every
// path it reads or writes is a function of it (paths.ts). The main renderer's
// home is today's XDG layout, so an installed user, the Rust client and the
// URL handler see no change; any other home is a directory with the layout
// beneath it. Built once at the process edge (`processWorld`), from two
// environment variables, and handed down as a value.
//
// [LAW:types-are-the-program] Two arms, each carrying its name and the per-uid
// runtime directory, so a derivation is one total function over the union and
// nothing downstream asks which variables were set.
export type RendererHome =
  | {
      readonly kind: "main";
      readonly name: typeof MAIN_NAME;
      readonly runtime: string;
      // The XDG bases, resolved: an empty variable means the default, as it
      // does for every XDG variable here.
      readonly roots: {
        readonly state: string;
        readonly cache: string;
        readonly config: string;
      };
      // [LAW:no-mode-explosion] exception: `CC_CANDYBAR_SOCKET`, honoured for
      // one release and warned on at the daemon's boot; the ticket that
      // retires it (f00.dum) deletes this field and every reader.
      readonly legacySocket: string | null;
    }
  | {
      readonly kind: "named";
      readonly name: RendererName;
      readonly runtime: string;
      readonly root: string;
    };

// [LAW:parse-dont-validate] A name that has passed the grammar below; nothing
// else can be one.
export type RendererName = string & { readonly RendererName: unique symbol };

export const MAIN_NAME: "main" = "main";

// Mirrored by the Rust client (rust-client/src/main.rs) and diffed by
// scripts/check-protocol.mjs: a client started with the two variables derives
// the same socket, state and cache as the daemon it reaches.
export const HOME_ENV = "CC_CANDYBAR_HOME";
export const NAME_ENV = "CC_CANDYBAR_NAME";
// The per-uid runtime directory's override, as the breaker's registry has
// one: a test worker's sockets live under its own temporary directory and
// never meet the machine's, and a renderer states it on every child it starts
// so the child reaches the directory its parent binds in (paths.ts).
export const RUNTIME_DIR_ENV = "CC_CANDYBAR_RUNTIME_DIR";
// The socket file a name derives in the runtime directory: main's stays
// `socket`; a named home's carries a suffix, so no name can collide with
// `socket`, the lease files or the breaker's `daemons/` beside it.
export const MAIN_SOCKET_FILE = "socket";
export const NAMED_SOCKET_SUFFIX = ".sock";
// The layout beneath a named home's root.
export const HOME_STATE_DIR = "state";
export const HOME_CACHE_DIR = "cache";
export const HOME_CONFIG_DIR = "config";
// [LAW:one-source-of-truth] Sized so `<runtime>/<name>.sock` stays under the
// 104-byte socket path limit with room for any uid.
export const RENDERER_NAME_MAX = 32;

const NAME_GRAMMAR = /^[a-z0-9][a-z0-9-]*$/;

// [LAW:types-are-the-program] What a link names: the main renderer, or a
// named one. A home's name is one of these, and so is the address a link
// carries, so a link can only ever name a renderer some home could be.
export type RendererAddress = typeof MAIN_NAME | RendererName;

// [LAW:one-source-of-truth] The name rule, grammar and length, said once.
// `where` is where the name came from, so a refusal names the variable or the
// link the user can go and fix. Private, because "main" passes it: each parse
// below says what "main" means where it reads a name.
function nameOf(raw: string, where: string): RendererName {
  if (!NAME_GRAMMAR.test(raw)) {
    throw new Error(
      `${where} must be lowercase letters, digits and dashes, starting with a letter or digit, got ${JSON.stringify(raw)}`,
    );
  }
  if (raw.length > RENDERER_NAME_MAX) {
    throw new Error(
      `${where} must be at most ${RENDERER_NAME_MAX} characters, got ${raw.length}: ${JSON.stringify(raw)}`,
    );
  }
  return raw as RendererName;
}

export function parseRendererName(raw: string): RendererName {
  const name = nameOf(raw, NAME_ENV);
  if (name === MAIN_NAME) {
    throw new Error(
      `${NAME_ENV} may not be ${JSON.stringify(MAIN_NAME)}: that is the main renderer's name, which is what an unset ${HOME_ENV} and ${NAME_ENV} mean`,
    );
  }
  return name;
}

// [LAW:parse-dont-validate] The name a link addresses. A link may name main,
// which is where an unset home's renderer listens.
export function parseRendererAddress(raw: string): RendererAddress {
  return raw === MAIN_NAME ? MAIN_NAME : nameOf(raw, "a link's renderer name");
}

// [LAW:one-source-of-truth] The socket file is one function of the name, which
// the URL handler computes from a link's name alone (url-handler/address.swift,
// held to this by scripts/check-protocol.mjs).
export function socketFile(name: RendererAddress): string {
  return name === MAIN_NAME
    ? MAIN_SOCKET_FILE
    : `${name}${NAMED_SOCKET_SUFFIX}`;
}

// An XDG variable: set and non-empty, else absent.
export function xdgEnv(
  env: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string | undefined {
  const v = env[name];
  return v && v.length > 0 ? v : undefined;
}

// [LAW:one-source-of-truth] The per-uid directory, as tmux's /tmp/tmux-<uid>:
// the uid is kernel identity, /tmp is on every Unix host and clears on reboot,
// which the daemon doesn't survive. Main's socket, every named socket, their
// leases and the breaker's registry sit here. The URL handler, which starts
// with no shell's environment, spells the same directory.
export function uidRuntimeDir(): string {
  // The kernel's uid, as the Rust client reads it: no passwd lookup, so a uid
  // with no entry (a container's) still has its directory.
  const uid = process.getuid!();
  return path.join("/tmp", `cc-candybar-${uid}`);
}

// [LAW:parse-dont-validate] The override is refused relative for the reason a
// relative root is: the daemon is spawned with no cwd, so a relative directory
// names a different socket in every process that derives it.
export function runtimeDir(host: Host): string {
  const override = xdgEnv(host.env, RUNTIME_DIR_ENV);
  if (override === undefined) return uidRuntimeDir();
  if (!path.isAbsolute(override)) {
    throw new Error(
      `${RUNTIME_DIR_ENV} must be an absolute path, got ${JSON.stringify(override)}`,
    );
  }
  return override;
}

// [LAW:parse-dont-validate] The one place the two variables are read. Both set
// is a named home; neither is main; one without the other is refused here,
// before any path is derived, naming the missing one.
export function homeOf(host: Host): RendererHome {
  const { env } = host;
  const root = xdgEnv(env, HOME_ENV);
  const name = xdgEnv(env, NAME_ENV);
  const legacySocket = xdgEnv(env, "CC_CANDYBAR_SOCKET") ?? null;
  const runtime = runtimeDir(host);
  if (root !== undefined && name !== undefined) {
    // Both runtimes spawn the daemon with no cwd, so a relative root would name
    // a different tree in every process that derives it while the socket, from
    // the name alone, stayed shared: one renderer, several trees.
    if (!path.isAbsolute(root)) {
      throw new Error(
        `${HOME_ENV} must be an absolute path, got ${JSON.stringify(root)}`,
      );
    }
    if (legacySocket !== null) {
      throw new Error(
        `CC_CANDYBAR_SOCKET is set beside ${HOME_ENV} and ${NAME_ENV}: a named renderer's socket is its name's, so unset it`,
      );
    }
    return { kind: "named", name: parseRendererName(name), runtime, root };
  }
  if (root !== undefined || name !== undefined) {
    const [set, missing] =
      root !== undefined ? [HOME_ENV, NAME_ENV] : [NAME_ENV, HOME_ENV];
    throw new Error(
      `${set} is set without ${missing}: a renderer's home is both, or neither for the main renderer`,
    );
  }
  return {
    kind: "main",
    name: MAIN_NAME,
    runtime,
    roots: {
      state:
        xdgEnv(env, "XDG_STATE_HOME") ??
        path.join(host.home, ".local", "state"),
      cache: xdgEnv(env, "XDG_CACHE_HOME") ?? path.join(host.home, ".cache"),
      config: xdgEnv(env, "XDG_CONFIG_HOME") ?? path.join(host.home, ".config"),
    },
    legacySocket,
  };
}
