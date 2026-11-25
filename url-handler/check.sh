#!/bin/sh
# The URL handler's pure reads (url-handler/wire.swift) against the daemon's
# spellings: compiled with its expectations and run once. The release workflow
# runs this on its macOS runner before the build, because the app's I/O is the
# only part of it nothing can test, and everything it decides is here.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

swiftc -o "$work/check" "$here/wire.swift" "$here/tests/main.swift"
"$work/check"
