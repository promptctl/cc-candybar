// [LAW:one-source-of-truth] The bare flags Node answers itself; the Rust client mirrors it.
export const NODE_FLAGS = {
  help: ["-h", "--help"],
  version: ["-V", "--version"],
} as const;
