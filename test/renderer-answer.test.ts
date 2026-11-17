// The main renderer answers a statusline request through `answer` alone
// (src/renderer-interface/interface.ts): the request's turn returns one `present` for
// the statusline, carrying the request it answers and the frame drawn, and the
// present's `effect-done` is what records what the frame showed. A world state
// the host hands in is what its session's view draws from, a retire closes the
// view, and every output says what the open views need read.
//
// [LAW:behavior-not-structure] The renderer is built over the daemon's own
// view composition (test/helpers/session-rig.ts) and narrow fakes for the host
// parts its side still reaches; no daemon is built.

import { daemonFactsOf } from "./helpers/daemon-facts";
import { sessionIdOf, type SessionId } from "../src/daemon/foundations/session-id";
import type { DoctorAsk } from "../src/doctor/gather";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "../src/daemon/foundations/protocol";
import { checkRenderRequest } from "../src/daemon/render-checkpoint";
import type {
  Effect,
  Present,
  Event,
  Renderer,
  RendererOutput,
  RequestId,
  Subscription,
  Viewers,
} from "../src/renderer-interface/interface";
import {
  mainRenderer,
  rendererClocks,
  type RendererClocks,
} from "../src/renderer/main";
import { renderFrame, type RendererParts } from "../src/renderer/draw-bar";
import { MOVING_FPS, perLane, UNFOLLOWED_FEEDS } from "../src/config/lanes";
import { FEED_PERIODS } from "../src/renderer/feeds";
import { parseFrame, renderFailedFrame, textOf } from "../src/render/frame";
import { closesAt, MENU_TIMEOUT_DEFAULT } from "../src/config/menu-timeout";
import { NO_VERBS, rendererParts } from "./helpers/renderer-parts";
import type { CheckedRenderRequest } from "../src/renderer-interface/request-context";
import { systemTimekeeper } from "../src/time";
import { instantAt, type Instant } from "../src/utils/instant";
import {
  AT,
  PROJECT,
  SESSION,
  requestOf,
  sessionRig,
  type SessionRig,
} from "./helpers/session-rig";
import { ok } from "../src/utils/outcome";
import { fakeTmux } from "./helpers/payload-owners";
import { rendererHost } from "../src/daemon/renderer-host";
import type {
  MainRendererParts,
  RendererVerbs,
} from "../src/renderer/verbs/port";
import { answerStatusline } from "../src/daemon/statusline-answer";
import type { DaemonFacts, WorldState } from "../src/facts/world-state";
import type { HeldEvent } from "../src/utils/event-hold";
import {
  hearingEvents,
  NO_ACTS,
  NO_PUSHES,
  takenBy,
  timedOf,
} from "./helpers/renderers";
import { SESSION_RENDER_ORIGIN_KEY } from "../src/daemon/foundations/session-keys";

let dir: string;
let cleanups: Array<() => void>;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-answer-")));
  cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
});

// The renderer over the rig's render cache and owners, the copies each
// delivered frame recorded in that cache, in the order they were recorded,
// every line the daemon's log was handed, and each pipe event an answer told
// the host it carried. `daemon` is what every world state carries of the
// daemon itself.
function renderer(
  verbs?: RendererVerbs,
  daemon?: () => DaemonFacts,
): {
  readonly r: Renderer;
  readonly parts: MainRendererParts;
  readonly clocks: RendererClocks;
  readonly recorded: string[][];
  // Each session whose view told the cache its data moved, in order.
  readonly changed: string[];
  readonly logged: string[];
  readonly pipesAnswered: HeldEvent[];
  readonly rig: SessionRig;
} {
  const logged: string[] = [];
  const changed: string[] = [];
  const pipesAnswered: HeldEvent[] = [];
  const rig = sessionRig(dir, cleanups, {
    log: (level, message) => logged.push(`${level} ${message}`),
    observers: { onViewChanged: (sessionId) => changed.push(sessionId) },
    ...(daemon === undefined ? {} : { daemon }),
  });
  const parts: MainRendererParts = {
    ...rendererParts({
      cache: rig.cache,
      sessionState: rig.sessionState,
      worldStates: rig.served.worldStates,
      verbs,
    }),
    eventAnswered: (event) => pipesAnswered.push(event),
    // The renderer's lines are the daemon log's, as the rig's are.
    log: (level, message) => logged.push(`${level} ${message}`),
  };
  // The cache's record of a delivered frame, heard on its way in.
  const recorded: string[][] = [];
  const record = rig.cache.delivered.bind(rig.cache);
  rig.cache.delivered = (sessionId, by, copies) => {
    recorded.push([...copies.values()]);
    record(sessionId, by, copies);
  };
  const clocks = rendererClocks(parts);
  return {
    r: mainRenderer(parts, clocks, NO_PUSHES),
    parts,
    clocks,
    recorded,
    changed,
    logged,
    pipesAnswered,
    rig,
  };
}

// A statusline request for the rig's session, through the host's checkpoint.
// It passes a flag the client does not know, so its bar lists one error.
// `pane` is the tmux pane its client reports, if any; `source` its config.
function checked(pane?: string, source = "{}"): CheckedRenderRequest {
  const configFile = path.join(dir, "config.json5");
  fs.writeFileSync(configFile, source);
  const { hookData } = requestOf(dir);
  const result = checkRenderRequest(
    {
      v: PROTOCOL_VERSION,
      kind: "render",
      hookData,
      args: ["cc-candybar", "--config", configFile, "--bogus"],
      cwd: PROJECT,
      encoding: "frame",
      ...(pane === undefined
        ? {}
        : { tmux: { socket: "/tmp/tmux.sock", pane, truecolor: null } }),
    },
    { firstSightOfUnknownHookField: () => false },
    () => {},
    dir,
  );
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.req;
}

const REQUEST = 7 as RequestId;

// The session's config as the host delivers one ahead of a request: with the
// world state its collector read at the request's keys, and its output's
// subscriptions handed back to the collector.
const configure = async (
  { r, rig }: { r: Renderer; rig: SessionRig },
  context: CheckedRenderRequest,
) => {
  const output = await r.answer({
    kind: "event",
    at: AT,
    event: {
      kind: "config",
      context,
      worldState: rig.served.collector.requested(context),
    },
  });
  rig.served.collector.subscribed(output.subscriptions);
  return output;
};

// The request as the host delivers one: after the session's config.
const request = async (t: { r: Renderer; rig: SessionRig }) => {
  const context = checked();
  await configure(t, context);
  return t.r.answer({
    kind: "event",
    at: AT,
    event: {
      kind: "request",
      id: REQUEST,
      context,
    },
  });
};

const handIn = (r: Renderer, event: Event) =>
  r.answer({ kind: "event", at: AT, event });

// The session's view as the cache holds it, released at once.
function viewOf(rig: SessionRig) {
  const held = rig.cache.holdView(SESSION);
  if (held === null) return null;
  held[Symbol.dispose]();
  return held.view;
}

const done = (r: Renderer, { session, id: of }: Effect, ok: boolean) =>
  r.answer({
    kind: "event",
    at: AT,
    event: {
      kind: "effect-done",
      session,
      of,
      outcome: ok ? { kind: "ok" } : { kind: "failed", reason: "left" },
    },
  });

// A turn's output, as the turn that answered or the one that threw.
const answered = (output: RendererOutput) => {
  if (output.kind !== "answered")
    throw new Error(`the turn threw: ${output.failure.detail}`);
  return output;
};
const threw = (output: RendererOutput) => {
  if (output.kind !== "threw") throw new Error("the turn answered");
  return output;
};

const presentOf = (effects: readonly Effect[]): Present => {
  expect(effects).toHaveLength(1);
  const [present] = effects;
  if (present?.kind !== "present") throw new Error("the turn presented nothing");
  return present;
};

describe("a statusline request", () => {
  test("is answered by one present for the statusline, carrying its request and the drawn bar", async () => {
    const { effects, record } = answered(await request(renderer()));
    const present = presentOf(effects);
    expect(present).toMatchObject({
      kind: "present",
      surface: "statusline",
      session: SESSION,
      request: REQUEST,
    });
    expect(present.frame.rows.length).toBeGreaterThan(0);
    // The turn's record is the draw's half of the render event; how long it
    // took is the host's, timed around the turn.
    expect(new Map(record).has("menuIdle")).toBe(true);
    expect(new Map(record).has("drew")).toBe(false);
  });

  // A restarted renderer: the host releases whatever its first output does
  // not name, a tmux status row included.
  test("of each live session is configured by a start's one turn, whose output names them all", async () => {
    const { r, rig } = renderer();
    const mine = checked();
    const other = sessionIdOf("other-session");
    const theirs: CheckedRenderRequest = {
      ...mine,
      hookData: { ...mine.hookData, session_id: other },
    };
    const output = await r.answer({
      kind: "event",
      at: AT,
      event: {
        kind: "start",
        viewers: {},
        sessions: [mine, theirs].map((context) => ({
          context,
          worldState: rig.served.collector.requested(context),
        })),
      },
    });
    expect(output.kind).toBe("answered");
    expect(Object.keys(output.subscriptions.sources).sort()).toEqual(
      [SESSION, other].sort(),
    );
  });

  test("has its context's facts on its config turn's record, which opens with the session", async () => {
    const { record } = await configure(renderer(), checked());
    expect(record[0]).toEqual(["sid", SESSION]);
    expect(new Map(record).get("badArgs")).toMatch(/--bogus/);
    expect(new Map(record).get("encoding")).toBe("frame");
  });

  test("whose view closed after its config turn opens it again at its own context and is answered", async () => {
    const t = renderer();
    const context = checked();
    await configure(t, context);
    // An eviction between the two turns.
    t.rig.cache.retireSession(SESSION);
    expect(viewOf(t.rig)).toBeNull();
    const { effects } = answered(
      await t.r.answer({
        kind: "event",
        at: AT,
        event: {
          kind: "request",
          id: REQUEST,
          context,
        },
      }),
    );
    expect(presentOf(effects)).toMatchObject({ request: REQUEST });
    expect(viewOf(t.rig)?.facts()).toBe(context);
  });

  test("draws the daemon's own faults its world state carries, and an answer that carried the pipe event tells the host once it arrived", async () => {
    const event = {
      text: "a launched program's pipe outlived its launch",
      at: AT,
      answered: false,
    };
    const t = renderer(undefined, () => ({
      ...daemonFactsOf(),
      launcher: [
        {
          kind: "lifeline",
          message: "programs launched now would outlive their launcher",
        },
        { kind: "launch-pipes", event },
      ],
    }));
    const { effects, record } = answered(await request(t));
    const facts = new Map(record);
    expect(facts.get("warn")).toBe("lifeline,launch-pipes");
    expect(facts.get("pipeEvent")).toBe("held");
    expect(t.pipesAnswered).toEqual([]);
    answered(await done(t.r, presentOf(effects), true));
    expect(t.pipesAnswered).toEqual([event]);
  });

  test("draws an act's failure no session's bar held as the daemon's warning, and an answer that carried it tells the host once it arrived", async () => {
    const event = {
      text: "copy: pbcopy failed: exit 1",
      at: AT,
      answered: false,
    };
    const t = renderer(undefined, () => ({
      ...daemonFactsOf(),
      actFailed: event,
    }));
    const { effects, record } = answered(await request(t));
    expect(new Map(record).get("warn")).toBe("act-failed");
    expect(t.pipesAnswered).toEqual([]);
    answered(await done(t.r, presentOf(effects), true));
    expect(t.pipesAnswered).toEqual([event]);
  });

  test("records what its frame showed only once the present's effect-done says it arrived", async () => {
    const { r, recorded, rig } = renderer();
    const { effects } = answered(await request({ r, rig }));
    expect(recorded).toEqual([]);
    await done(r, presentOf(effects), true);
    expect(recorded).toEqual([[expect.stringMatching(/--bogus/)]]);
  });

  test("records nothing for a present its client never took, and hears of each present once", async () => {
    const { r, recorded, rig } = renderer();
    const present = presentOf(answered(await request({ r, rig })).effects);
    await done(r, present, false);
    expect(recorded).toEqual([]);
    expect(threw(await done(r, present, true)).failure.message).toMatch(
      /no present, change or act on its way/,
    );
  });
});

describe("a feed's frame", () => {
  test("records what it showed as it is drawn, under the feed, apart from the request's", async () => {
    const { r, parts, recorded, rig } = renderer();
    answered(await request({ r, rig }));
    const by: string[] = [];
    const record = rig.cache.delivered.bind(rig.cache);
    rig.cache.delivered = (sessionId, drawer, copies) => {
      by.push(drawer);
      record(sessionId, drawer, copies);
    };
    const drawn = renderFrame(parts, SESSION, AT, MOVING_FPS, {
      following: new Set(),
      feeds: UNFOLLOWED_FEEDS,
      idleSince: null,
    });
    expect(drawn?.frame.failure).toBeNull();
    expect(recorded).toEqual([[expect.stringMatching(/--bogus/)]]);
    expect(by).toEqual(["feed"]);
  });

  // A wake while a frame is out is owed a frame after it, so a draw that woke
  // its own feed would keep a still bar drawing at the moving rate.
  test("moves nothing its feed wakes for: neither the view's data nor the session's state", async () => {
    const { r, parts, changed, rig } = renderer();
    answered(await request({ r, rig }));
    const draw = (at: Instant) =>
      renderFrame(parts, SESSION, at, MOVING_FPS, {
        following: new Set(),
        feeds: UNFOLLOWED_FEEDS,
        idleSince: null,
      })?.frame;
    const changedBefore = changed.length;
    const revision = rig.sessionState.latestRevision();
    expect(draw(AT)?.failure).toBeNull();
    expect(draw((AT + 1) as Instant)?.failure).toBeNull();
    expect(changed.slice(changedBefore)).toEqual([]);
    expect(rig.sessionState.latestRevision()).toBe(revision);
  });
});

// [LAW:no-ambient-temporal-coupling] The renderer reads no clock: a feed is
// driven only by the viewers the host hands in and the `due` at each instant
// the renderer declared, so these instants are the case's own.
describe("a feed driven by its dues", () => {
  // A bar that turns every quarter second.
  const TURNING = `{
    segments: { anim: { template: '{{ frames 0.25 "a" 0.25 "b" }}' } },
    root: { h: ['anim'] },
  }`;
  const watchedBy = (shown: boolean): Viewers => ({
    [SESSION]: {
      lanes: perLane((lane) => ({
        subscribers: lane === "band" ? 1 : 0,
        drawing: lane === "band",
      })),
      shown,
    },
  });
  // Each due at the instant the last turn declared, `n` of them: the gap
  // from each to the next, and the text of each frame pushed.
  const dues = async (r: Renderer, from: Instant, n: number) => {
    const gaps: number[] = [];
    const texts: string[] = [];
    let wake = from;
    for (let i = 0; i < n; i++) {
      const out = answered(
        await r.answer({ kind: "event", at: wake, event: { kind: "due" } }),
      );
      for (const frame of out.frames)
        texts.push(textOf(parseFrame(frame.bar)));
      const next = out.subscriptions.wake!;
      gaps.push(Math.round((next - wake) * 1000));
      wake = next;
    }
    return { gaps, texts, wake };
  };

  test("draws a turning bar on a screen once a turn, and an unseen one a still period apart, declaring each next instant as it draws", async () => {
    const t = renderer();
    await configure(t, checked(undefined, TURNING));
    const opened = answered(
      await handIn(t.r, { kind: "viewers", viewers: watchedBy(true) }),
    );
    // The feed's first frame is due at once.
    expect(opened.subscriptions.wake).toBe(AT);
    const shown = await dues(t.r, AT, 5);
    expect(shown.gaps.slice(1)).toEqual([250, 250, 250, 250]);
    expect(shown.texts).toHaveLength(5);
    expect(new Set(shown.texts).size).toBe(2);
    const hidden = answered(
      await t.r.answer({
        kind: "event",
        at: shown.wake,
        event: { kind: "viewers", viewers: watchedBy(false) },
      }),
    );
    const unseen = await dues(t.r, hidden.subscriptions.wake!, 3);
    expect(unseen.gaps).toEqual([
      FEED_PERIODS.still,
      FEED_PERIODS.still,
      FEED_PERIODS.still,
    ]);
  });

  test("no longer watched, it pushes nothing and wants no wake", async () => {
    const t = renderer();
    await configure(t, checked(undefined, TURNING));
    await handIn(t.r, { kind: "viewers", viewers: watchedBy(true) });
    const closed = answered(
      await handIn(t.r, { kind: "viewers", viewers: {} }),
    );
    expect(closed.subscriptions.wake).toBeNull();
    expect(answered(await handIn(t.r, { kind: "due" })).frames).toEqual([]);
  });
});

test("a feed's frame whose view will not open is the failure's Frame, a still bar in the error glyph's words", () => {
  const parts = {
    renderCache: {
      holdView: () => null,
      openFailure: () => ({ error: new Error("the view would not open") }),
    },
  } as unknown as RendererParts;
  const { frame } = renderFrame(parts, SESSION, AT, 30, {
    following: new Set(["band"]),
    feeds: UNFOLLOWED_FEEDS,
    idleSince: null,
  })!;
  expect(frame.bar).toEqual(renderFailedFrame("the view would not open"));
  expect(frame.bar.nextChange).toBe(Infinity);
  expect(JSON.parse(frame.answers.resp)).toMatchObject({
    ok: false,
    code: "RENDER_FAILED",
    error: "the view would not open",
  });
});

describe("the world state the host hands in", () => {
  test("is what the session's view draws from, and an older seq is refused", async () => {
    const t = renderer();
    await request(t);
    const held = t.rig.served.worldStates.of(SESSION);
    const next = {
      ...held,
      seq: held.seq + 1,
      builtins: { ...held.builtins, hostName: { ...ok("elsewhere"), at: AT } },
    };
    const { effects } = answered(
      await handIn(t.r, {
        kind: "world-state",
        worldState: next,
      }),
    );
    expect(effects).toEqual([]);
    expect(viewOf(t.rig)?.source.facts()).toBe(next);
    expect(
      threw(await handIn(t.r, { kind: "world-state", worldState: held }))
        .failure.message,
    ).toMatch(/does not follow the held seq/);
  });

  test("a retire closes the session's view and drops its world state, and logs no error", async () => {
    const t = renderer();
    await request(t);
    expect(viewOf(t.rig)).not.toBeNull();
    const { subscriptions } = await handIn(t.r, {
      kind: "retire",
      session: SESSION,
    });
    expect(viewOf(t.rig)).toBeNull();
    expect(subscriptions.sources).toEqual({});
    expect(() => t.rig.served.worldStates.of(SESSION)).toThrow(
      /no world state for session/,
    );
    // The view stopped observing the document before it went.
    expect(t.logged.filter((line) => line.startsWith("error"))).toEqual([]);
  });

  test("a retire whose session teardown throws still drops its world state, so the host's next record for the session is taken", async () => {
    const t = renderer();
    await request(t);
    const held = t.rig.served.worldStates.of(SESSION);
    // A newer document held, so `held` is taken again only by a new record.
    await handIn(t.r, {
      kind: "world-state",
      worldState: { ...held, seq: held.seq + 1 },
    });
    const retireSession = t.rig.cache.retireSession.bind(t.rig.cache);
    t.rig.cache.retireSession = (session) => {
      retireSession(session);
      throw new Error("the view's teardown threw");
    };
    expect(
      threw(await handIn(t.r, { kind: "retire", session: SESSION })).failure
        .message,
    ).toBe("the view's teardown threw");
    expect(() => t.rig.served.worldStates.of(SESSION)).toThrow(
      /no world state for session/,
    );
    // A new record starts again below the seq the dropped document had.
    await handIn(t.r, { kind: "world-state", worldState: held });
    expect(t.rig.served.worldStates.of(SESSION)).toBe(held);
  });

  // A view evicted, or one that failed to open, is no reason a run the
  // session asked for goes unread.
  test("every output names each session's doctor run, whether or not a view of it is open", async () => {
    const t = renderer();
    const other = "no-view-session" as SessionId;
    const run = (n: number): Subscription => ({
      kind: "doctor",
      ask: { run: n } as unknown as DoctorAsk,
    });
    t.parts.doctorRuns.subscriptions = () =>
      new Map([
        [SESSION, run(1)],
        [other, run(2)],
      ]);
    const { subscriptions } = await request(t);
    expect(subscriptions.sources[SESSION]?.at(-1)).toEqual(run(1));
    expect(subscriptions.sources[other]).toEqual([run(2)]);
    expect(Object.keys(subscriptions.lanes)).not.toContain(other);
  });

  test("every output names each open view's plugin sources at their storage keys", async () => {
    const t = renderer();
    const { subscriptions } = await request(t);
    const view = viewOf(t.rig)!;
    expect(subscriptions.sources).toEqual({
      [SESSION]: [...view.state.sources].map(([source, storage]) => ({
        kind: "plugin",
        source,
        storage,
      })),
    });
  });
});

describe("the session's config, ahead of its request", () => {
  test("opens the session's view and names what it reads, with no effect", async () => {
    const t = renderer();
    const { effects, subscriptions } = answered(await configure(t, checked()));
    expect(effects).toEqual([]);
    const view = viewOf(t.rig)!;
    expect(subscriptions.sources).toEqual({
      [SESSION]: [...view.state.sources].map(([source, storage]) => ({
        kind: "plugin",
        source,
        storage,
      })),
    });
    expect(presentOf(answered(await request(t)).effects)).toMatchObject({
      kind: "present",
      request: REQUEST,
    });
  });

  test("one that throws answers its request with a failure naming the renderer, and the request is not delivered", async () => {
    const t = renderer();
    t.rig.cache.holdSession = (() => {
      throw new Error("the opening broke");
    }) as never;
    const kinds: string[] = [];
    const host = rendererHost(
      "main",
      systemTimekeeper,
      timedOf(hearingEvents(t.r, (input) => kinds.push(input.event.kind))),
      () => {},
      takenBy(t.rig.served.collector),
      NO_ACTS,
    );
    // The collector's inputs go through the host, as the daemon's do, so no
    // world state overtakes the config it follows.
    t.rig.served.route(host);
    const facts: Array<readonly [string, string]> = [];
    const answered = await answerStatusline(
      host,
      t.rig.served.collector,
      systemTimekeeper,
      new AbortController().signal,
      () => {},
      checked(),
      REQUEST,
      (instantAt(systemTimekeeper) + 5) as Instant,
      facts as never,
    );
    expect(kinds).toContain("config");
    expect(kinds).not.toContain("request");
    expect(answered.resp).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /^renderer main: its config turn: the opening broke/,
      ),
    });
    // The render event still opens with the session, and says what the
    // context the opening was for carried.
    expect(facts[0]).toEqual(["sid", SESSION]);
    expect(new Map(facts).get("badArgs")).toMatch(/--bogus/);
  });

  test("a request with no config before it is refused, naming the session", async () => {
    const t = renderer();
    const answering = await t.r.answer({
      kind: "event",
      at: AT,
      event: {
        kind: "request",
        id: REQUEST,
        context: checked(),
      },
    });
    expect(threw(answering).failure.message).toMatch(
      new RegExp(`no world state for session "${SESSION}"`),
    );
  });

  test("one whose opening throws has still recorded the config inputs it named, so a durable click resolves the chain it was for", async () => {
    const t = renderer();
    t.rig.cache.holdSession = (() => {
      throw new Error("the opening broke");
    }) as never;
    expect(threw(await configure(t, checked())).failure.message).toBe(
      "the opening broke",
    );
    expect(
      t.rig.sessionState.get(SESSION, SESSION_RENDER_ORIGIN_KEY),
    ).toContain(path.join(dir, "config.json5"));
  });
});

describe("two requests of one session at different keys", () => {
  test("each reaches the renderer with the world state read at its own keys, and both answers draw the newest request's", async () => {
    const t = renderer();
    // The pane's tmux session, answered when the case lands it.
    const landings = new Map<string, () => void>();
    const tmux = fakeTmux(
      (_holds, hint) =>
        new Promise((resolve) =>
          landings.set(hint.pane, () => resolve(ok(`on ${hint.pane}`))),
        ),
    );
    t.rig.providers.tmuxService.declare = tmux.declare as never;
    const requests: WorldState[] = [];
    const host = rendererHost(
      "main",
      systemTimekeeper,
      timedOf(
        hearingEvents(t.r, (input) => {
          if (input.event.kind === "config")
            requests.push(input.event.worldState);
        }),
      ),
      () => {},
      takenBy(t.rig.served.collector),
      NO_ACTS,
    );
    t.rig.served.route(host);
    const ask = (pane: string, id: number) =>
      answerStatusline(
        host,
        t.rig.served.collector,
        systemTimekeeper,
        new AbortController().signal,
        () => {},
        checked(pane),
        id as RequestId,
        (instantAt(systemTimekeeper) + 10) as Instant,
        [],
      );

    let firstAnswered = false;
    const first = ask("%1", 1).then((a) => {
      firstAnswered = true;
      return a;
    });
    // The second arrives while the first waits on its pane.
    const second = ask("%2", 2);
    // Each config reaches the renderer as its turn in the mailbox comes.
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests.map((w) => w.builtins.tmux.kind)).toEqual([
      "pending",
      "pending",
    ]);
    // The pane the session left lands: nothing reads it, so the first still
    // waits, now on the newest request's pane.
    landings.get("%1")!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(firstAnswered).toBe(false);
    landings.get("%2")!();
    const answered = await Promise.all([first, second]);
    for (const { resp } of answered) expect(resp).toMatchObject({ ok: true });
    const view = viewOf(t.rig)!;
    expect(view.facts().hints.tmux?.pane).toBe("%2");
    expect(view.source.facts().builtins.tmux).toMatchObject({
      kind: "ok",
      value: { session: "on %2" },
    });
  });
});

describe("a click", () => {
  // A click on the rig's session's link, delivered by the CLI.
  const click = (
    verb: string,
    latest: CheckedRenderRequest | null = null,
  ): Event => ({
    kind: "click",
    verb,
    value: "",
    session: { ok: true, id: SESSION },
    arrival: { via: "link", delivery: { kind: "cli" } },
    latest,
  });

  test("answers with what the open views read once its handler has run", async () => {
    // The handler closes the session's view, so an output read before it ran
    // would still name the view's sources.
    let act = (): void => {};
    const t = renderer({
      ...NO_VERBS,
      handler: (verb) => (verb === "act" ? () => act() : undefined),
      closeIdle: () => {
        throw new Error("no idle close here");
      },
    });
    act = () => t.rig.cache.retireSession(SESSION);
    const before = await request(t);
    expect(Object.keys(before.subscriptions.sources)).toEqual([SESSION]);
    const { effects, subscriptions, record } = answered(
      await handIn(t.r, click("act")),
    );
    expect(effects).toEqual([]);
    expect(subscriptions.sources).toEqual({});
    // The host records what it knows of the click; this act waited on nothing.
    expect(record).toEqual([]);
  });

  test("that throws once its handler has acted names what the open views read then", async () => {
    let act = (): void => {};
    const t = renderer({
      ...NO_VERBS,
      handler: (verb) => (verb === "act" ? () => act() : undefined),
      closeIdle: () => {
        throw new Error("no idle close here");
      },
    });
    act = () => {
      t.rig.cache.retireSession(SESSION);
      throw new Error("a later step broke");
    };
    const before = await request(t);
    expect(Object.keys(before.subscriptions.sources)).toEqual([SESSION]);
    const thrown = threw(await handIn(t.r, click("act")));
    expect(thrown.failure.message).toBe("a later step broke");
    expect(thrown.subscriptions.sources).toEqual({});
  });

  test("hands its act the host's newest request of its session, though the session has retired", async () => {
    let seen: CheckedRenderRequest | null | undefined;
    const t = renderer({
      ...NO_VERBS,
      handler: (verb) =>
        verb === "act"
          ? (_value, facts) => {
              seen = facts.latest;
            }
          : undefined,
      closeIdle: () => {
        throw new Error("no idle close here");
      },
    });
    await request(t);
    await handIn(t.r, { kind: "retire", session: SESSION });
    const latest = checked("%3");
    answered(await handIn(t.r, click("act", latest)));
    expect(seen).toBe(latest);
  });

  test("of a verb the renderer does not have is its bad request", async () => {
    const t = renderer();
    const { failure } = threw(await handIn(t.r, click("nope")));
    expect(failure).toMatchObject({
      kind: "bad-request",
      message: "unknown click verb: nope",
    });
  });
});

// [LAW:no-ambient-temporal-coupling] The renderer keeps the idle period
// itself and declares when the close falls due; the host's wake hands it a
// `due` then, which closes the menus in its own turn.
describe("the idle close", () => {
  // A bar whose group is open by default: its first draw draws a menu.
  const MENU = `{ root: { v: [
    { kind: 'group', name: 'more', label: 'more', open: true, children: ['model'] },
    'directory',
  ] } }`;
  // The request drawn at AT, with its menu, and the closes the verbs made.
  const drawnWithMenu = async () => {
    const closed: Array<{ session: string; idleS: number }> = [];
    const t = renderer({
      ...NO_VERBS,
      handler: () => undefined,
      closeIdle: (sessionId, _latest, idle) => {
        closed.push({ session: sessionId, idleS: idle.idleS });
      },
    });
    const context = checked(undefined, MENU);
    await configure(t, context);
    const output = answered(
      await t.r.answer({
        kind: "event",
        at: AT,
        event: { kind: "request", id: REQUEST, context },
      }),
    );
    return { t, closed, output };
  };
  const dueAt = (r: Renderer, at: Instant) =>
    r.answer({ kind: "event", at, event: { kind: "due" } });

  test("falls due a timeout after the draw that first drew the menu, and the request's output declares it", async () => {
    const { output } = await drawnWithMenu();
    expect(output.subscriptions.wake).toBe(closesAt(AT, MENU_TIMEOUT_DEFAULT));
  });

  test("closes the session's menus in its own turn at that instant, with no effect, and wants no wake for them after", async () => {
    const { t, closed, output } = await drawnWithMenu();
    const wake = output.subscriptions.wake!;
    expect(answered(await dueAt(t.r, (wake - 0.1) as Instant)).effects).toEqual(
      [],
    );
    expect(closed).toEqual([]);
    const shut = answered(await dueAt(t.r, wake));
    expect(shut.effects).toEqual([]);
    expect(closed).toEqual([{ session: SESSION, idleS: wake - AT }]);
    expect(shut.subscriptions.wake).toBeNull();
  });

  test("a close that throws is said, its session shut all the same, and the due answers", async () => {
    const { t, output } = await drawnWithMenu();
    t.parts.verbs.closeIdle = () => {
      throw new Error("the close broke");
    };
    const shut = answered(await dueAt(t.r, output.subscriptions.wake!));
    expect(shut.subscriptions.wake).toBeNull();
    expect(t.logged).toContainEqual(
      expect.stringMatching(
        new RegExp(`^error menu-idle: close threw \\(session=${SESSION}\\): the close broke`),
      ),
    );
  });

  test("a click's landing begins the period again", async () => {
    const { t } = await drawnWithMenu();
    const clickedAt = (AT + 10) as Instant;
    t.clocks.menuIdle.clicked(SESSION, clickedAt);
    expect(t.clocks.menuIdle.next()).toBe(
      closesAt(clickedAt, MENU_TIMEOUT_DEFAULT),
    );
  });

  test("a retire drops the session's period", async () => {
    const { t } = await drawnWithMenu();
    await handIn(t.r, { kind: "retire", session: SESSION });
    expect(t.clocks.menuIdle.next()).toBeNull();
  });
});
