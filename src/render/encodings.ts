// How a drawn frame crosses the wire: to a client that asked for a render, and
// to a lane's subscribers.

// [LAW:no-mode-explosion] A render is answered in one of two encodings: the
// ANSI a terminal prints, or the Frame. The cap is these two, and the second
// has no exit, since a reader holding one render's answer has no other way to
// read the bar once decoding is ruled out.
export const RENDER_ENCODINGS = ["ansi", "frame"] as const;
export type RenderEncoding = (typeof RENDER_ENCODINGS)[number];

// A lane's pushed frames take a render encoding, or the ANSI with its hit map
// beside it: a follower that reads the mouse itself in a terminal (the tmux bar
// pane, whose mouse mode turns the terminal's own links off) finds where a
// pointer can act from the hit map, as a Frame's reader finds it on each run.
// [LAW:no-mode-explosion] The cap is these three, one per kind of reader: a
// terminal that opens the links itself, a terminal follower that hit-tests,
// and a page.
export type FeedEncoding = RenderEncoding | "hit-mapped";

// [LAW:one-source-of-truth] Whether a frame in this encoding says where a
// pointer can act on it. Only a follower whose frames do may own the session's
// pointer, since the hover it reports is the action it found there.
export const SAYS_WHERE_POINTER_ACTS: Readonly<Record<FeedEncoding, boolean>> =
  {
    ansi: false,
    "hit-mapped": true,
    frame: true,
  };
