demo:
    npx tsx src/demo/app.ts

# Full local deploy: build the bundle and stage the native render-path
# binary. After this, a statusline launcher pointing at the checkout
# renders HEAD. On a machine without cargo, `pnpm install && pnpm build`
# alone is a complete (node-entry) deploy.
deploy:
    pnpm install
    pnpm build
    just install-rust

# Build the native render-path client and stage it at bin/cc-candybar-native.
# The committed bin/cc-candybar node shim stays untouched — the native binary
# is a separate, gitignored artifact. CI stages release binaries into the
# per-platform npm packages instead (see .github/workflows/release.yml).
install-rust:
    cd rust-client && cargo build --release
    cp rust-client/target/release/cc-candybar bin/cc-candybar-native
    chmod +x bin/cc-candybar-native
    @file bin/cc-candybar-native
    @echo "Native binary staged at bin/cc-candybar-native."
