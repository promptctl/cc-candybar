#!/bin/sh
# An unchanged helper keeps its Accessibility identity on updates.
set -eu
out="${1:?usage: build.sh <output-binary>}"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$(dirname "$out")"
work="$(mktemp -d "$(dirname "$out")/.bar-window.XXXXXX")"
trap 'rm -rf "$work"' EXIT
(cd "$here" && shasum -a 256 ./*.swift build.sh) > "$work/inputs"
shasum -a 256 < "$work/inputs" > "$work/digest-line"
cut -d ' ' -f 1 "$work/digest-line" > "$work/source"
if [ -x "$out" ] && cmp -s "$work/source" "$out.source" && codesign --verify "$out" 2>/dev/null; then
    exit 0
fi
for arch in arm64 x86_64; do
    swiftc -O -module-name CCCandybarWindow -target "${arch}-apple-macos12.0" \
        -o "$work/$arch" "$here"/*.swift
done
lipo -create "$work/arm64" "$work/x86_64" -output "$work/helper"
codesign --force --sign - --identifier com.cccandybar.window --timestamp=none "$work/helper"
codesign --verify "$work/helper"
chmod 0755 "$work/helper"
# A valid signature alone cannot prove the loader can execute the image.
if "$work/helper" 2>"$work/usage"; then
    exit 1
else
    test "$?" -eq 64
    grep -q '^usage: cc-candybar-window' "$work/usage"
fi
mv -f "$work/helper" "$out"
mv -f "$work/source" "$out.source"
