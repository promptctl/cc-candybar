// [LAW:one-source-of-truth] The bare flags Node answers itself. The dispatch in
// index.ts reads it, `--help` renders its own lines from it, and the Rust client
// routes exactly these to Node (its NODE_FLAGS; check-protocol diffs the two),
// so a spelling added here without its mirror fails the build, not the user.
export const NODE_FLAGS = {
  help: ["-h", "--help"],
  version: ["-V", "--version"],
} as const;
