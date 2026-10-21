// brandon-doctor-v62x.5at: how often Claude Code redraws a session's bar, read
// off its render requests' arrivals — the fact the effect-refresh check
// judges, as the click and `cc-candybar doctor` each read it.
import {
  REDRAW_WINDOW_S,
  REDRAWN_SECONDS,
  redrawsOf,
  slowestOf,
} from "../src/doctor/redraws";
import type { Redraws } from "../src/doctor/redraws";
import { framesOf } from "../src/doctor/cli";
import { parseFrameSightings } from "../src/doctor/daemon-answer";
import type { StatsSnapshot } from "../src/daemon/stats";
import { PACKAGE_VERSION } from "../src/version";

// Ages, in whole seconds before now, of renders every `interval` seconds from
// `from` back over `over` seconds, less any `stalled` ages.
const ticks = (interval: number, over: number, from = 0, stalled: number[] = []) =>
  Array.from({ length: Math.floor(over / interval) + 1 }, (_, i) => from + i * interval).filter(
    (age) => !stalled.includes(age),
  );

describe("redrawsOf", () => {
  test("a render a second, through a daemon stall of five seconds, clears the floor", () => {
    const redraws = redrawsOf(ticks(1, 119, 0, [20, 21, 22, 23, 24]), 120, 0);
    expect(redraws).toEqual({ kind: "seen", seconds: REDRAW_WINDOW_S - 5 });
    expect(REDRAW_WINDOW_S - 5).toBeGreaterThanOrEqual(REDRAWN_SECONDS);
  });

  test("a render every two seconds, or on events now and then, does not", () => {
    expect(redrawsOf(ticks(2, 119), 120, 0)).toEqual({ kind: "seen", seconds: 30 });
    expect(redrawsOf([0, 3, 4, 17, 40, 41, 42], 120, 0)).toEqual({ kind: "seen", seconds: 7 });
  });

  // A bar on screen and idle on events alone: its last render was long ago,
  // and the silence since is what the window sees.
  test("a window ending now counts the silence since the last render", () => {
    expect(redrawsOf(ticks(1, 59, 70), 200, 0)).toEqual({ kind: "seen", seconds: 0 });
    // Ending at that last render instead, the same record looks redrawn.
    expect(redrawsOf(ticks(1, 59, 70), 200, 70)).toEqual({ kind: "seen", seconds: 60 });
  });

  test("a record shorter than the window is unseen, however full", () => {
    expect(redrawsOf(ticks(1, 30), 30.6, 0)).toEqual({ kind: "unseen", over: 30 });
    // Its window ending at the last render, the record covers less still.
    expect(redrawsOf(ticks(1, 40, 10), 50, 10)).toEqual({ kind: "unseen", over: 40 });
  });
});

describe("slowestOf", () => {
  test("the bar below the floor before one unseen before one redrawn; fewest seconds first within each", () => {
    const every: { readonly redraws: Redraws } = { redraws: { kind: "seen", seconds: 58 } };
    const almost: { readonly redraws: Redraws } = { redraws: { kind: "seen", seconds: 50 } };
    const slow: { readonly redraws: Redraws } = { redraws: { kind: "seen", seconds: 12 } };
    const slower: { readonly redraws: Redraws } = { redraws: { kind: "seen", seconds: 3 } };
    const unseen: { readonly redraws: Redraws } = { redraws: { kind: "unseen", over: 30 } };
    expect(slowestOf([every, slow, unseen])).toBe(slow);
    expect(slowestOf([slow, slower])).toBe(slower);
    expect(slowestOf([every, unseen])).toBe(unseen);
    expect(slowestOf([every, almost])).toBe(almost);
  });
});

describe("framesOf: where each session's window ends", () => {
  // Session `s1` rendered every second until 70 s ago; `s2` is rendering now.
  const sighting = (sessionId: string, from: number) => ({
    role: "statusline" as const,
    frame: "moves" as const,
    claudeConfigDir: "/claude",
    ago: from,
    sessionId,
    since: from + 120,
    redrawn: ticks(1, 59, from),
  });
  const asked = { kind: "ok", value: [sighting("s1", 70), sighting("s2", 0)] } as const;

  test("the session this command runs in ends now; any other at its last render", () => {
    expect(framesOf(asked, "/claude", "s1")).toEqual({
      kind: "ok",
      value: [
        { role: "statusline", frame: "moves", redraws: { kind: "seen", seconds: 0 } },
        { role: "statusline", frame: "moves", redraws: { kind: "seen", seconds: 60 } },
      ],
    });
    expect(framesOf(asked, "/claude", undefined)).toMatchObject({
      value: [{ redraws: { kind: "seen", seconds: 60 } }, { redraws: { kind: "seen", seconds: 60 } }],
    });
  });
});

describe("parseFrameSightings", () => {
  const stats = (client: Record<string, unknown>) =>
    ({ version: PACKAGE_VERSION, clients: [client] }) as unknown as StatsSnapshot;
  const good = {
    role: "statusline",
    frame: "moves",
    claudeConfigDir: "/claude",
    ago: 1,
    sessionId: "s1",
    since: 90,
    redrawn: [1, 2, 3],
  };

  test("a sighting carrying when it was redrawn is read", () => {
    expect(parseFrameSightings(stats(good))).toEqual({ kind: "ok", value: [good] });
  });

  test.each([
    ["no redraw record", { ...good, redrawn: undefined }],
    ["a fractional second", { ...good, redrawn: [1.5] }],
    ["no second at all", { ...good, redrawn: [] }],
    ["no record start", { ...good, since: undefined }],
    ["no session", { ...good, sessionId: undefined }],
  ])("%s → failed, naming the daemon's build", (_, client) => {
    expect(parseFrameSightings(stats(client))).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("what they drew and when"),
    });
  });
});
