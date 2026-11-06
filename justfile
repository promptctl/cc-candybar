[positional-arguments]
demo *args:
    pnpm demo "$@"

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
# The build is stamped with the digest of the crate's source (Cargo.toml,
# Cargo.lock, src/), so the doctor can tell a binary from the source it was
# built from. `cargo metadata` settles Cargo.lock before the digest is taken,
# and `--locked` refuses a build that would change it after.
install-rust:
    cd rust-client && cargo metadata --format-version 1 >/dev/null && digest="$(../node_modules/.bin/tsx ../scripts/crate-digest.ts .)" && CC_CANDYBAR_RUST_SOURCE="$digest" cargo build --release --locked
    cp rust-client/target/release/cc-candybar bin/cc-candybar-native
    chmod +x bin/cc-candybar-native
    @file bin/cc-candybar-native
    @echo "Native binary staged at bin/cc-candybar-native."

# Build the URL handler app binary (url-handler/main.swift) and stage it at
# bin/cc-candybar-url-handler-native, where `cc-candybar install` run from this
# checkout wraps it in the app bundle. CI builds the release copy into the
# darwin npm packages instead (see .github/workflows/release.yml).
install-url-handler:
    ./url-handler/build.sh bin/cc-candybar-url-handler-native
    @echo "URL handler binary staged at bin/cc-candybar-url-handler-native."

# Test the URL handler's address rule (url-handler/address.swift), as CI's
# macOS job does before it builds the app.
test-url-handler:
    ./url-handler/test.sh
