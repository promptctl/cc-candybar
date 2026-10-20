// The mod's contract: what its child writes to it, one JSON object per line —
// each message the daemon sends a band-lane subscriber, relayed as it was sent
// (`cc-candybar-native follow`, rust-client/src/follow.rs) — and the values it
// keeps in `$.state`.
//
// [LAW:one-source-of-truth] The daemon's band encoding (src/band/frames.ts)
// and its wire response type (src/daemon/protocol.ts) import the line's types
// from here; this file is the one statement of the line the daemon and the mod
// share.

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

// One row of a bar, left to right.
export type BandRow = readonly BandRun[];

// One bar: every row it draws, top to bottom. The daemon answers a band-lane
// subscriber's every frame with one, a render that failed included (its error
// glyph, drawn as the statusline draws it).
export interface BandBar {
  readonly ok: true;
  readonly band: readonly BandRow[];
}

// The band's lane switched off in candybar's settings (`🧪 band (A)`): the
// daemon's own refusal of the subscription, and `error` its sentence naming
// the toggle. The band draws nothing.
export interface BandOff {
  readonly ok: false;
  readonly code: 'SWITCHED_OFF';
  readonly error: string;
  readonly daemonV?: number;
}

// [LAW:types-are-the-program] One line of the stream: a bar, or the lane
// switched off. An empty bar is a bar, never mistaken for the lane being off.
export type BandLine = BandBar | BandOff;

declare module 'claude-code' {
  interface PluginState {
    'candybar-band': {
      // What the band draws: the newest line, null until the first arrives;
      // and what is wrong now, above it, null while lines arrive: the child's
      // last word since its last line, a line the band cannot draw, or why the
      // child stopped.
      band: { frame: BandLine | null; failure: string | null };
    };
  }
}
