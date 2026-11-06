#!/bin/sh
# Build and run the URL handler's address test (address-test.swift) over the
# rule the app ships (address.swift). CI's macOS job runs it before it builds
# the app; `just test-url-handler` runs it in a checkout. Only `swiftc` from
# the Command Line Tools is needed.
set -eu

dir="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

swiftc -parse-as-library -o "$work/address-test" "$dir/address.swift" "$dir/address-test.swift"
"$work/address-test"
