// The mod's contract: what `cc-candybar frames` writes to it, one JSON object
// per line, and the values it keeps in `$.state`.
//
// [LAW:one-source-of-truth] The child (src/band/frames.ts) imports the frame
// types from here; this file is the one statement of the line the two
// processes share.

// A colour as the mod's `Text` takes one: `#rrggbb`, or the name of one of the
// terminal's own sixteen (`red`, `blackBright`), which its theme draws.
export type RunColor = string;

// One stretch of a row in one style. `href` is the OSC 8 target the stretch
// lies under: a `cc-candybar://` click, an `https:` page, a `file:` path.
export interface BandRun {
  readonly text: string;
  readonly color?: RunColor;
  readonly backgroundColor?: RunColor;
  readonly bold?: true;
  readonly dimColor?: true;
  readonly italic?: true;
  readonly underline?: true;
  readonly strikethrough?: true;
  readonly inverse?: true;
  readonly href?: string;
}

// One frame: every row the bar draws, top to bottom.
export interface BandFrame {
  readonly rows: readonly (readonly BandRun[])[];
}

declare module 'claude-code' {
  interface PluginState {
    'candybar-band': {
      // The newest frame; null until the first arrives.
      frame: BandFrame | null;
      // Why the frames child stopped when nothing asked it to; null while it runs.
      failure: string | null;
    };
  }
}
