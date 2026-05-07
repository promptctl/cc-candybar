demo:
    npx tsx src/demo/app.ts

# Build the native render-path client and stage it at bin/cc-candybar so
# the locally-installed statusline picks it up. The committed bin entry is
# the placeholder stub; CI's postinstall does this same overwrite from
# matrix-built artifacts.
install-rust:
    cd rust-client && cargo build --release
    cp rust-client/target/release/cc-candybar bin/cc-candybar
    chmod +x bin/cc-candybar
    @file bin/cc-candybar
    @echo "Native binary staged at bin/cc-candybar."
