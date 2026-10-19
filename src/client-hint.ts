// What the statusline client IS — the one fact about a render only the client
// that sent it can state: which program drew the bar, and which bundle it
// belongs to. The doctor's "install is current" check reasons over it
// (src/doctor/checks.ts), because the settings file only says what is
// supposed to run — a launcher script, managed settings, or a project file
// may stand between it and the client that actually rendered.
//
// [LAW:one-source-of-truth] A bundle is named one way everywhere: the file of
// the bundle the program runs. The Rust client reports the
// `<exe dir>/../dist/index.mjs` it already execs for its daemon and its
// fallback (rust-client/src/main.rs, `dist_index_path`); a Node client and
// the daemon name the file their own entry module was loaded from.

// [LAW:types-are-the-program] Which program sent the render. `node` is the
// per-render Node relay — the fallback, paying node's startup on every
// render; `frames` is `cc-candybar frames`, Node too, but one long-lived
// process whose startup is paid once (src/frames-cli.ts).
export const CLIENT_KINDS = ["native", "node", "frames"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

export interface ClientHint {
  readonly kind: ClientKind;
  // Absolute path of the bundle the client runs or execs.
  readonly bundle: string;
  // The native binary's build stamp: the `crateDigest` of the rust-client
  // crate it was built from (`just install-rust` passes it in), null for a binary
  // built without one (CI's, a bare `cargo build`) and for a Node client,
  // whose code IS its bundle.
  readonly source: string | null;
}

// A Node client's identity: the bundle it runs, no build stamp. `bundle` is
// the entry's own file (`import.meta.url` in src/index.ts), which Node's
// loader has already resolved through every link — so naming it costs the
// render no read, and cannot fail.
export function nodeClientHint(
  kind: Exclude<ClientKind, "native">,
  bundle: string,
): ClientHint {
  return { kind, bundle, source: null };
}
