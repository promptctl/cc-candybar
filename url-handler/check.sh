#!/bin/sh
# Check the URL handler on a macOS machine: its pure reads against the
# expectations in tests/main.swift, and the app itself for type errors. The
# release workflow runs this on a macOS runner before it builds the binary.
# Only `swiftc` from the Command Line Tools is needed.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

swiftc -typecheck "$here/wire.swift" "$here/main.swift"
swiftc -o "$work/expectations" "$here/wire.swift" "$here/tests/main.swift"
"$work/expectations"
