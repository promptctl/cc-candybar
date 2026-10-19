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
// the daemon name theirs by `bundleOf` below, the same adjacency.

import fs from "node:fs";
import path from "node:path";

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

// [LAW:one-source-of-truth] THE rule a bundle is named by, from the program
// a process was started as: a `.mjs`/`.js` is the bundle itself (`node
// dist/index.mjs`), anything else a bin whose bundle is the adjacent
// `../dist/index.mjs` — the adjacency the committed shim imports by, and the
// path the Rust client execs (`dist_index_path`). `install` stages the bundle
// it names; the daemon names itself by it and a Node client reports it, so
// the doctor compares two answers of one rule.
export function bundleOf(program: string | undefined): string {
  if (!program) {
    throw new Error("process.argv[1] not set");
  }
  if (program.endsWith(".mjs") || program.endsWith(".js")) {
    return program;
  }
  return path.resolve(path.dirname(program), "..", "dist", "index.mjs");
}

// The bundle this process runs: the rule applied to the FILE it was started
// as. Node keeps a symlinked bin's own path in argv[1] (an npm global
// install's `/usr/local/bin/cc-candybar` → `<pkg>/bin/cc-candybar`), and the
// adjacency holds beside the file the link names, not beside the link.
export function runningBundle(): string {
  const program = process.argv[1];
  return bundleOf(program && fs.realpathSync(program));
}

// A Node client's identity: the bundle it runs, no build stamp.
export function nodeClientHint(
  kind: Exclude<ClientKind, "native">,
): ClientHint {
  return { kind, bundle: runningBundle(), source: null };
}
