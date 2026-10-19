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

// One bar: every row it draws, top to bottom.
export interface BandBar {
  readonly kind: 'bar';
  readonly rows: readonly (readonly BandRun[])[];
}

// The band's lane switched off in candybar's settings (`🧪 band (A)`): the
// band draws nothing, and `reason` is the daemon's sentence naming the toggle.
export interface BandOff {
  readonly kind: 'off';
  readonly reason: string;
}

// [LAW:types-are-the-program] One line of the stream: a bar, or the lane
// switched off. An empty bar is a bar, never mistaken for the lane being off.
export type BandFrame = BandBar | BandOff;

declare module 'claude-code' {
  interface PluginState {
    'candybar-band': {
      // What the band draws: the newest frame, null until the first arrives;
      // and what is wrong now, above it, null while frames arrive: the
      // frames child's last word since its last frame, or why it stopped.
      band: { frame: BandFrame | null; failure: string | null };
    };
  }
}
