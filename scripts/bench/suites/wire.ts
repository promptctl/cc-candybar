// A statusline tick against the built daemon, over its socket, through the
// client's own request: what Claude Code's wait for the bar is made of.
//
// Each benchmark owns a daemon of its own, started fresh and stopped after, so
// what one left in the caches is never what the next measures.
//
// Every sample is vouched for. A warm tick is judged against the daemon's own
// record of it: the render event says it drew with nothing pending, and the
// daemon's counters say no cache entry was built and no request erred or timed
// out while it ran. A tick that was fast because it drew nothing is a failure.

import fs from "node:fs";

import { effectsUrl, VERB_SET_STATE } from "../../../src/click/wire.js";
import { linksOf } from "../../../src/click/read.js";
import { DISCLOSURE_CLOSED } from "../../../src/config/disclosure.js";
import { tryClickViaDaemon } from "../../../src/daemon/client.js";
import { describeFailure } from "../../../src/daemon/client-transport.js";
import type { StatsSnapshot } from "../../../src/daemon/stats.js";
import { parseHandlerUrl } from "../../../src/install/index.js";
import { composeBar } from "../../../src/render/frame.js";
import type { RepoShape } from "../fixtures.js";
import { sleep } from "../measure.js";
import { measured, type Benchmark, type Outcome } from "../types.js";
import {
  drawn,
  inWorld,
  type RenderEvent,
  type Session,
  type Tick,
  type World,
} from "../world.js";

// A working checkout: a few hundred files, a dirty tree, an upstream.
const CHECKOUT: RepoShape = { files: 200, commits: 20, modified: 8, untracked: 4 };
// A small one, for the benchmarks that need many.
const SMALL_CHECKOUT: RepoShape = { files: 50, commits: 3, modified: 2, untracked: 1 };
// A session of a few hours.
const TURNS = 1_700;
const WARMUP_TICKS = 10;
const DEFAULT_COLUMNS = 120;

// [LAW:no-silent-failure] What makes a warm sample a warm sample, said by the
// daemon: every event drew ok with nothing pending, and between the two
// readings of its counters no entry, view or compile was built and no request
// erred. A request the client gave up on is not unsoundness: it is the datum a
// latency benchmark exists for, counted by the caller.
function warmVouched(
  what: string,
  before: StatsSnapshot,
  after: StatsSnapshot,
  events: readonly RenderEvent[],
): void {
  const unsound = events.filter((e) => e.outcome !== "ok" || e.pending !== "-");
  if (unsound.length > 0) {
    throw new Error(
      `${what}: ${unsound.length} of ${events.length} ticks did not draw clean, e.g. ${JSON.stringify(unsound[0])}`,
    );
  }
  const moved: string[] = [];
  for (const key of ["size", "views", "compiles"] as const) {
    if (after.renderCache[key] !== before.renderCache[key]) {
      moved.push(`renderCache.${key} ${before.renderCache[key]} -> ${after.renderCache[key]}`);
    }
  }
  for (const key of ["errored", "timedOut"] as const) {
    if (after.requests[key] !== before.requests[key]) {
      moved.push(`requests.${key} ${before.requests[key]} -> ${after.requests[key]}`);
    }
  }
  if (moved.length > 0) {
    throw new Error(`${what}: the daemon changed while it was measured: ${moved.join(", ")}`);
  }
}

// A tick the client gave up on is a sample, at the time it waited: a bar Claude
// Code showed nothing for. Only a run that mostly went unanswered measured
// nothing.
function answered(ticks: readonly Tick[], what: string): number {
  const unanswered = ticks.filter((t) => !t.ok).length;
  if (unanswered * 2 > ticks.length) {
    throw new Error(`${what}: ${unanswered} of ${ticks.length} ticks went unanswered`);
  }
  return unanswered;
}

// The daemon's record of a run of ticks. With every tick answered, each has
// exactly one event and the series are the daemon's own view of them. A tick the
// client gave up on may still be running in the daemon, so its late event can
// land among the others: pairing by count then could pair a straggler with the
// wrong tick, and the daemon-side series are left out rather than forged.
// [LAW:no-silent-failure]
async function daemonSide(
  world: World,
  sessionId: string,
  from: number,
  ticks: readonly Tick[],
): Promise<{ events: RenderEvent[]; exact: boolean }> {
  const answeredCount = ticks.filter((t) => t.ok).length;
  return {
    events: await world.events(sessionId, from, answeredCount),
    exact: answeredCount === ticks.length,
  };
}

const daemonSeries = (side: { events: RenderEvent[]; exact: boolean }) =>
  side.exact
    ? [
        { name: "took", samples: side.events.map((e) => e.tookMs) },
        { name: "queued", samples: side.events.map((e) => e.queuedMs) },
      ]
    : [];

// ── the warm tick ───────────────────────────────────────────────────────────

const WIDTHS = [80, 120, 200] as const;

const warmTick = (columns: number): Benchmark => ({
  id: `wire.tick.w${columns}`,
  group: "wire",
  about: `a tick of a settled session, ${columns} columns wide, one after another with no pause: the daemon's service time per tick. rtt is the client's round trip; took and queued are the daemon's own, in whole ms`,
  samples: 300,
  async run(plan) {
    return inWorld(async (world) => {
      const session = world.session("a", CHECKOUT, TURNS);
      await world.settle(session, columns);
      let n = 100;
      for (let i = 0; i < WARMUP_TICKS; i++) {
        drawn(await world.tick(session, columns, n++), "warm-up");
      }
      const before = await world.stats();
      const from = world.mark(session.id);
      const ticks: Tick[] = [];
      for (let i = 0; i < plan.samples; i++) {
        ticks.push(await world.tick(session, columns, n++));
      }
      const unanswered = answered(ticks, `wire.tick.w${columns}`);
      const side = await daemonSide(world, session.id, from, ticks);
      const after = await world.stats();
      warmVouched(`wire.tick.w${columns}`, before, after, side.events);
      return measured(
        [
          { name: "rtt", samples: ticks.map((t) => t.ms) },
          ...daemonSeries(side),
        ],
        {
          unanswered,
          usageMisses: after.usageCache.misses - before.usageCache.misses,
        },
      );
    });
  },
});

// ── ticks of many sessions at once ──────────────────────────────────────────

const PERIOD_MS = 250;

const concurrentTicks = (sessions: number): Benchmark => ({
  id: `wire.tick.sessions.${sessions}`,
  group: "wire",
  about: `${sessions} settled sessions, each in a checkout of its own, each ticking every ${PERIOD_MS} ms from its own offset (${((sessions * 1000) / PERIOD_MS).toFixed(0)} ticks a second asked of one daemon): what a tick waits behind. samples is ticks per session`,
  samples: 40,
  async run(plan) {
    return inWorld(async (world) => {
      const all: Session[] = Array.from({ length: sessions }, (_, i) =>
        world.session(`s${i}`, SMALL_CHECKOUT, 300),
      );
      await Promise.all(all.map((s) => world.settle(s, DEFAULT_COLUMNS)));
      const before = await world.stats();
      const marks = all.map((s) => world.mark(s.id));
      const perSession: Tick[][] = all.map(() => []);
      const started = performance.now();
      await Promise.all(
        all.map(async (session, i) => {
          // An offset of its own, so the sessions are not one synchronized burst.
          const offset = (i * PERIOD_MS) / sessions;
          for (let n = 0; n < plan.samples; n++) {
            const due = started + offset + n * PERIOD_MS;
            await sleep(Math.max(0, due - performance.now()));
            perSession[i]!.push(await world.tick(session, DEFAULT_COLUMNS, 1000 + n));
          }
        }),
      );
      const ticks = perSession.flat();
      const unanswered = answered(ticks, `wire.tick.sessions.${sessions}`);
      const sides = await Promise.all(
        all.map((s, i) => daemonSide(world, s.id, marks[i]!, perSession[i]!)),
      );
      const side = {
        events: sides.flatMap((x) => x.events),
        exact: sides.every((x) => x.exact),
      };
      const after = await world.stats();
      warmVouched(`wire.tick.sessions.${sessions}`, before, after, side.events);
      return measured(
        [
          { name: "rtt", samples: ticks.map((t) => t.ms) },
          ...daemonSeries(side),
        ],
        { sessions, periodMs: PERIOD_MS, unanswered },
      );
    });
  },
});

// ── cold paths ──────────────────────────────────────────────────────────────

// The cost of a bar from a session the daemon has not drawn: the first tick
// (which may spend its whole deadline and draw nothing) and the time to a bar
// with nothing pending.
interface Cold {
  readonly firstTick: number[];
  readonly firstBar: number[];
}

const coldSeries = (cold: Cold): Outcome =>
  measured([
    { name: "first-tick", samples: cold.firstTick },
    { name: "first-bar", samples: cold.firstBar },
  ]);

const coldDaemon: Benchmark = {
  id: "wire.cold.daemon",
  group: "wire",
  about:
    "a daemon that was not running: from its spawn to its first answered stats (boot, polled every 25 ms), then a first session's first tick and its first bar with nothing pending",
  samples: 5,
  async run(plan) {
    const boot: number[] = [];
    const cold: Cold = { firstTick: [], firstBar: [] };
    for (let i = 0; i < plan.samples; i++) {
      await inWorld(async (world) => {
        const session = world.session("a", CHECKOUT, TURNS);
        const settled = await world.settle(session, DEFAULT_COLUMNS);
        boot.push(world.bootMs);
        cold.firstTick.push(settled.firstMs);
        cold.firstBar.push(settled.settledMs);
      });
    }
    return measured([
      { name: "boot", samples: boot },
      { name: "first-tick", samples: cold.firstTick },
      { name: "first-bar", samples: cold.firstBar },
    ]);
  },
};

const coldSession: Benchmark = {
  id: "wire.cold.session",
  group: "wire",
  about:
    "a new session in a checkout and config the daemon already draws: the first tick and the first bar with nothing pending",
  samples: 15,
  async run(plan) {
    return inWorld(async (world) => {
      const base = world.session("base", CHECKOUT, TURNS);
      await world.settle(base, DEFAULT_COLUMNS);
      const cold: Cold = { firstTick: [], firstBar: [] };
      for (let i = 0; i < plan.samples; i++) {
        const settled = await world.settle(
          world.another(base, `n${i}`, TURNS),
          DEFAULT_COLUMNS,
        );
        cold.firstTick.push(settled.firstMs);
        cold.firstBar.push(settled.settledMs);
      }
      return coldSeries(cold);
    });
  },
};

const coldDirectory: Benchmark = {
  id: "wire.cold.directory",
  group: "wire",
  about:
    "a new session in a checkout the daemon has not seen, under a config it already compiled: the first tick and the first bar with nothing pending",
  samples: 12,
  async run(plan) {
    return inWorld(async (world) => {
      await world.settle(world.session("base", CHECKOUT, TURNS), DEFAULT_COLUMNS);
      const cold: Cold = { firstTick: [], firstBar: [] };
      for (let i = 0; i < plan.samples; i++) {
        const settled = await world.settle(
          world.session(`d${i}`, CHECKOUT, TURNS),
          DEFAULT_COLUMNS,
        );
        cold.firstTick.push(settled.firstMs);
        cold.firstBar.push(settled.settledMs);
      }
      return coldSeries(cold);
    });
  },
};

// ── a change that reaches every bar ─────────────────────────────────────────

const LOOK_BUDGET_MS = 60_000;
const PROBE_PACE_MS = 20;

// Runs `change`, then ticks `probe` until its bar differs from `before`: the
// time to the changed bar, and the longest tick the probe waited through on
// the way (a loop that is busy answers late, or not at all inside its
// deadline, and that tick is a tick Claude Code showed nothing for).
async function untilChanged(
  world: World,
  probe: Session,
  before: string,
  n0: number,
  change: () => Promise<void>,
): Promise<{ visibleMs: number; stallMs: number; unanswered: number; output: string }> {
  const started = performance.now();
  await change();
  let stallMs = 0;
  let unanswered = 0;
  for (let n = n0; performance.now() - started < LOOK_BUDGET_MS; n++) {
    const tick = await world.tick(probe, DEFAULT_COLUMNS, n);
    stallMs = Math.max(stallMs, tick.ms);
    if (!tick.ok) unanswered++;
    else if (tick.output !== before) {
      return { visibleMs: performance.now() - started, stallMs, unanswered, output: tick.output };
    }
    await sleep(PROBE_PACE_MS);
  }
  throw new Error(`the bar did not change within ${LOOK_BUDGET_MS} ms of the change`);
}

const PRESETS = ["compact", "zen"] as const;

const configReload = (entries: number): Benchmark => ({
  id: `wire.reload.${entries}`,
  group: "wire",
  about: `the config file rewritten while the daemon draws ${entries} ${entries === 1 ? "checkout" : "checkouts"} under it: from the write to a bar drawn from the new config (visible), and the longest tick a probe session waited through meanwhile (stall)`,
  samples: entries === 1 ? 8 : 4,
  async run(plan) {
    return inWorld(async (world) => {
      const sessions = Array.from({ length: entries }, (_, i) =>
        world.session(`e${i}`, SMALL_CHECKOUT, 300),
      );
      const probe = sessions[0]!;
      for (const s of sessions) await world.settle(s, DEFAULT_COLUMNS);
      let previous = drawn(await world.tick(probe, DEFAULT_COLUMNS, 1), "probe").output;
      const visible: number[] = [];
      const stall: number[] = [];
      let unanswered = 0;
      for (let i = 0; i < plan.samples; i++) {
        const preset = PRESETS[i % PRESETS.length]!;
        const changed = await untilChanged(world, probe, previous, 10, async () => {
          // Renamed into place, so the watcher never reads a truncated file.
          const staged = `${world.configFile}.next`;
          fs.writeFileSync(staged, `{ globals: { preset: "${preset}" } }\n`);
          fs.renameSync(staged, world.configFile);
        });
        visible.push(changed.visibleMs);
        stall.push(changed.stallMs);
        unanswered += changed.unanswered;
        previous = changed.output;
        // The next sample starts from a daemon that has finished with this
        // one, every checkout drawing again.
        for (const s of sessions) await world.settle(s, DEFAULT_COLUMNS);
      }
      return measured(
        [
          { name: "visible", samples: visible },
          { name: "stall", samples: stall },
        ],
        { entries, probeTicksUnanswered: unanswered },
      );
    });
  },
});

// ── a click ─────────────────────────────────────────────────────────────────

async function click(url: string): Promise<number> {
  const { verb, value } = parseHandlerUrl(url);
  const started = performance.now();
  const outcome = await tryClickViaDaemon(verb, value);
  const ms = performance.now() - started;
  // [LAW:no-silent-failure] A click the daemon refused did nothing; its round
  // trip is not a click's.
  if (outcome.kind !== "ok") {
    throw new Error(`click ${url} ended ${describeFailure(outcome)}`);
  }
  return ms;
}

const menuClicks: Benchmark = {
  id: "wire.click.menu",
  group: "wire",
  about:
    "opening and closing the settings menu: the click's round trip, and the first tick after it, which draws the menu or releases it",
  samples: 30,
  async run(plan) {
    return inWorld(async (world) => {
      const session = world.session("a", CHECKOUT, TURNS);
      await world.settle(session, DEFAULT_COLUMNS);
      const menu = (state: string): string =>
        effectsUrl([{ verb: VERB_SET_STATE, args: [session.id, "candybar.menu", state] }]);
      const series: Record<"click-open" | "draw-open" | "click-close" | "draw-close", number[]> = {
        "click-open": [],
        "draw-open": [],
        "click-close": [],
        "draw-close": [],
      };
      let n = 100;
      const closedLines = drawn(await world.tick(session, DEFAULT_COLUMNS, n++), "closed").output.split("\n").length;
      // One round before the first sample: what an open menu builds on its
      // first draw it holds from then on.
      for (let i = -1; i < plan.samples; i++) {
        const recorded = i >= 0;
        const open = await click(menu("open"));
        const drawOpen = drawn(await world.tick(session, DEFAULT_COLUMNS, n++), "menu open");
        // [LAW:no-silent-failure] An open menu draws more than the closed bar.
        if (drawOpen.output.split("\n").length <= closedLines) {
          throw new Error("the settings menu did not draw when clicked open");
        }
        const close = await click(menu(DISCLOSURE_CLOSED));
        const drawClose = drawn(await world.tick(session, DEFAULT_COLUMNS, n++), "menu closed");
        if (recorded) {
          series["click-open"].push(open);
          series["draw-open"].push(drawOpen.ms);
          series["click-close"].push(close);
          series["draw-close"].push(drawClose.ms);
        }
      }
      return measured(
        Object.entries(series).map(([name, samples]) => ({ name, samples })),
      );
    });
  },
};

const settingClick: Benchmark = {
  id: "wire.click.setting",
  group: "wire",
  about:
    "a click that changes a setting and writes the config file (the preset stepper): the click's round trip, and the time from the click to a bar drawn from the new config (visible)",
  samples: 10,
  async run(plan) {
    return inWorld(async (world) => {
      const session = world.session("a", CHECKOUT, TURNS);
      await world.settle(session, DEFAULT_COLUMNS);
      await click(
        effectsUrl([{ verb: VERB_SET_STATE, args: [session.id, "candybar.menu", "open"] }]),
      );
      const clicks: number[] = [];
      const visible: number[] = [];
      let n = 100;
      for (let i = 0; i < plan.samples; i++) {
        // The stepper the open menu draws: its next preset is a link to click,
        // and the bar it is read from is the one the click has to change.
        const menu = await world.frame(session, DEFAULT_COLUMNS, n++);
        const step = linksOf(menu).find((l) => l.text === "▶");
        if (step === undefined) {
          throw new Error("the open menu drew no ▶ preset stepper to click");
        }
        let clickMs = 0;
        const changed = await untilChanged(world, session, composeBar(menu), n, async () => {
          clickMs = await click(step.url);
        });
        n += 1000;
        clicks.push(clickMs);
        visible.push(changed.visibleMs);
      }
      return measured([
        { name: "click", samples: clicks },
        { name: "visible", samples: visible },
      ]);
    });
  },
};

export const WIRE: readonly Benchmark[] = [
  ...WIDTHS.map(warmTick),
  ...[8, 32].map(concurrentTicks),
  coldDaemon,
  coldSession,
  coldDirectory,
  ...[1, 20].map(configReload),
  menuClicks,
  settingClick,
];
