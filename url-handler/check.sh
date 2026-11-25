#!/bin/sh
# Compile the URL handler's wire reads (wire.swift) with their expectations
# (tests/main.swift) and run them. Only `swiftc` is needed, and no app, socket
# or daemon: what is read is bytes and names.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

swiftc -o "$work/wire-check" "$here/wire.swift" "$here/tests/main.swift"
"$work/wire-check"
