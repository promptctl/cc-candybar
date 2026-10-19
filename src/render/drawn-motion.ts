// [LAW:one-way-deps] The motion vocabulary of a drawn frame, a leaf both the
// renderer (`drawDsl`, src/dsl/render.ts) and the daemon's render sightings
// (src/daemon/render-sightings.ts) read, so neither imports the other.
// `moves` is what the frame's cells say; `can-move` is a still frame whose
// config, under the settings in force, can draw motion at a later render; else
// `still` (brandon-doctor-v62x.tgp).
export const DRAWN_MOTIONS = ["moves", "can-move", "still"] as const;
export type DrawnMotion = (typeof DRAWN_MOTIONS)[number];
