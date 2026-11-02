# Frame

Status: built. The type and the shared encoder helpers are in `src/render/frame.ts`. The decoders are gone from `src/`, `site/`, `scripts/` and `test/helpers/`.

## Owns

Draw's output, the encoders, and keeping rendered ANSI something nothing reads back.

## Why

ANSI is written once, for terminals. Everything that used to decode it was recovering structure the draw had already thrown away, and the other surfaces and the browser depend on that structure.

## What the code doesn't show

- **A run is one rich-js segment.** Merging equal neighbours changes the bytes, so merging belongs to the encoders that want it, band and tmux, and not to the Frame.
- **A Frame is drawn for one depth.** Contrast floors, shade windows, `standOff` and effects all read depth during the draw, so a frame can't be re-encoded at another depth with its floors intact. This is what makes depth a per-surface input for the [browser](../browser-surface.md).
- **Some writers stay ANSI, because they write bytes and read none:** `src/index.ts`, `src/bar-pane/paint.ts`, `rust-client/src/main.rs`, `rust-client/src/error_glyph.rs`, `formatPermanentGlyph`, `vendor/cc-extra/src/statusline-push.js`. The glyph writes BG then FG as two sequences, which an encoded Frame can't reproduce, so terminal clients keep the literal, held in step by `scripts/check-protocol.mjs`.

## Evidence

Each row went through JSON as runs, was rebuilt, and was encoded by rich-js's own encoder, then compared with the bytes the draw produced. Script: `probes/p5.mts`.

| Case | Rows | Result |
|---|---|---|
| Bundled default, every disclosure, with and without the settings menu | 538 across 264 states | All exact. JSON 872 KB, ANSI 850 KB |
| Config with every source kind, sparkle on | 15 across 5 states | All exact |

## To probe

- **The other three depths.** `test/default-menu-bytes.test.ts` runs at truecolor only, so the design's check across all four depths hasn't been run.
