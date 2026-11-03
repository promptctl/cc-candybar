#!/bin/sh
# Build the URL handler as one universal Mach-O at the path given. The release
# workflow runs this on a macOS runner and stages the result into both darwin
# platform packages; `just install-url-handler` runs it in a checkout. Only
# `swiftc` and `lipo` from the Command Line Tools are needed: no Xcode project.
# [LAW:one-source-of-truth] One build for every caller, so the binary install
# assembles the app around is the same whoever built it.
set -eu

out="${1:?usage: build.sh <output-binary>}"
src="$(cd "$(dirname "$0")" && pwd)/main.swift"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for arch in arm64 x86_64; do
  swiftc -O -target "${arch}-apple-macos12.0" -o "$work/$arch" "$src"
done
mkdir -p "$(dirname "$out")"
lipo -create "$work/arm64" "$work/x86_64" -output "$out"
chmod 0755 "$out"
file "$out"
