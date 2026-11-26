#!/bin/sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
swiftc -typecheck "$here"/*.swift
swiftc -o "$work/expectations" "$here/Geometry.swift" "$here/AdapterGeometry.swift" "$here/tests/main.swift"
"$work/expectations"
