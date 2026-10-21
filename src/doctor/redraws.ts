// How often Claude Code re-runs a session's statusline, read off the arrival
// of its render requests (brandon-doctor-v62x.5at) — the territory the
// effect-refresh check judges, where the settings files are only the map: a
// statusLine from `--settings`, MDM or server-managed settings outranks every
// file the doctor reads.
//
// Measured (27 sessions with `refreshInterval: 1`, 15 minutes of daemon.log):
// Claude Code's tick lands a request every 1.0 s, event-driven redraws add
// more between ticks, and the daemon's own stalls — every session at once,
// since the daemon stamps the arrival — leave gaps of up to 4.7 s. So the
// statistic is how many whole seconds of a window held an arrival: a stall
// costs a few of them, and an interval of 2 s or more costs half.

// The seconds a redraw rate is judged over.
export const REDRAW_WINDOW_S = 60;

// Of those, the seconds that must hold an arrival for the bar to count as
// redrawn every second.
export const REDRAWN_SECONDS = 45;

// [LAW:types-are-the-program] `unseen`: the record covers only `over`
// seconds before the window's end — a session this daemon has not watched for
// a whole window (it started, or the daemon restarted under it) — so its rate
// is not known yet. `seen`: how many of the window's seconds held an arrival.
export type Redraws =
  | { readonly kind: "seen"; readonly seconds: number }
  | { readonly kind: "unseen"; readonly over: number };

// [LAW:effects-at-boundaries] Pure over ages, in seconds before now:
// `redrawn`, the whole seconds that held an arrival; `since`, when the record
// began; `end`, where the window ends — now for a session whose bar is known
// to be on screen, so the silence since its last arrival counts, else its
// last arrival, since a session that closed and one idle on events alone look
// the same from the daemon.
export function redrawsOf(
  redrawn: readonly number[],
  since: number,
  end: number,
): Redraws {
  if (since < end + REDRAW_WINDOW_S) {
    return { kind: "unseen", over: Math.max(0, Math.floor(since - end)) };
  }
  return {
    kind: "seen",
    seconds: redrawn.filter((age) => age >= end && age < end + REDRAW_WINDOW_S)
      .length,
  };
}

export const redrawnEverySecond = (redraws: Redraws): boolean =>
  redraws.kind === "seen" && redraws.seconds >= REDRAWN_SECONDS;

// [LAW:types-are-the-program] How far a reading is from settling the check:
// a rate seen below the floor fails it, one not seen yet leaves it unknown,
// and one at or above the floor passes it — fewest seconds first within each.
const urgency = (redraws: Redraws): readonly [number, number] =>
  redraws.kind === "unseen"
    ? [1, redraws.over]
    : [redrawnEverySecond(redraws) ? 2 : 0, redraws.seconds];

// Bars in the order their readings decide the check: the slowest first, so
// one bar redrawn too rarely is not hidden by another redrawn every second.
export const bySlowest = (a: Redraws, b: Redraws): number => {
  const [x, y] = [urgency(a), urgency(b)];
  return x[0] - y[0] || x[1] - y[1];
};

// The bar of several whose reading decides the check.
export const slowestOf = <T extends { readonly redraws: Redraws }>(
  bars: readonly [T, ...T[]],
): T =>
  bars.reduce((worst, bar) =>
    bySlowest(bar.redraws, worst.redraws) < 0 ? bar : worst,
  );
