# cc-candybar native render client

Tiny Rust binary that replaces `node dist/index.mjs` on the statusline render
hot path. Distributed via per-platform npm packages
(`@promptctl/cc-candybar-<platform>`) declared as `optionalDependencies` of
the main package; the host's matching package is selected at install time
and the binary is staged to `bin/cc-candybar` by `scripts/postinstall.mjs`.

## What it does

- **Render path** (default, when stdin has hook data): connects to the
  daemon's Unix socket at `~/.claude/powerline/socket`, sends a framed
  `RenderRequest` (matching `src/daemon/protocol.ts`), prints the response
  to stdout. Daemon-miss → spawn detached Node daemon, emit `\n`, exit 0.
- **Subcommands** (`install`, `daemon`, `daemon-stats`, `url-handle`,
  `install-url-handler`, `--help`): `execvp`s `node <bin>/../dist/index.mjs`
  and forwards argv. The binary stays minimal; complex logic lives in TS.

Wire format and timeouts mirror the existing TS client byte-for-byte.
`scripts/check-protocol.mjs` (run in `prepublishOnly`) fails the publish if
`PROTOCOL_VERSION` ever drifts between this crate and `src/daemon/protocol.ts`.

## Build

```sh
cd rust-client
cargo build --release
# Binary at: target/release/cc-candybar (~365 KB stripped on aarch64-apple-darwin)
```

To test locally with the binary in its production layout (so the
`<bin>/../dist/index.mjs` resolution works):

```sh
mkdir -p /tmp/cc-cb/bin
cp rust-client/target/release/cc-candybar /tmp/cc-cb/bin/
ln -s "$PWD/dist" /tmp/cc-cb/dist
echo '{"session_id":"x","workspace":{"project_dir":"'$PWD'"},"model":{"id":"x","display_name":"x"}}' \
  | /tmp/cc-cb/bin/cc-candybar
```

## Why Rust

The render path runs on every Claude Code statusline refresh — observed at
~9 req/s sustained. Node's startup (~85 ms) is the dominant cost; the
daemon itself responds in ~5 ms. Replacing the relay process with a native
binary drops end-to-end latency from ~100 ms to ~40 ms (measured on
`aarch64-apple-darwin`). Rust was chosen over Go for binary size (~370 KB
vs ~3 MB) since this lands in every user's `node_modules` four times over.

## Source layout

```
rust-client/
├── Cargo.toml          opt-level=z, LTO, strip — minimum size
├── Cargo.lock          committed (binary crate, reproducible builds)
└── src/
    └── main.rs         single file, ~250 lines
```
