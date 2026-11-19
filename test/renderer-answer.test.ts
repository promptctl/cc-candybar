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

import { checkoutLocation } from "../src/utils/git-root";
import { TEST_ENV } from "./helpers/session-environment";
import { TEST_ENVIRONMENT } from "./helpers/session-environment";
import { daemonFactsOf } from "./helpers/daemon-facts";
import { MAIN_RENDERER } from "../src/daemon/foundations/renderer-name";
import {
  sessionIdOf,
  type SessionId,
} from "../src/daemon/foundations/session-id";
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
} from "../src/renderer-interface/interface";
import { mainRenderer } from "../src/renderer/main";
import {
  drawRender,
  renderFrame,
  setUpRender,
  type RendererParts,
} from "../src/renderer/draw-bar";
import { renderFailedFrame } from "../src/render/frame";
import { ANSWERING, MOVING_FPS, UNFOLLOWED_FEEDS } from "../src/config/lanes";
import { NO_VERBS, rendererParts } from "./helpers/renderer-parts";
import {
  heardContextOf,
  type CheckedRenderRequest,
  type SessionContext,
} from "../src/renderer-interface/request-context";
import { systemTimekeeper } from "../src/time";
import type { Instant, Tick } from "../src/utils/instant";
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
  hostHeld,
  NO_ACTS,
  NO_PUSHES,
  NOTHING_STORED,
  unfollowedCollector,
} from "./helpers/renderers";

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
  };
  // The cache's record of a delivered frame, heard on its way in.
  const recorded: string[][] = [];
  const record = rig.cache.delivered.bind(rig.cache);
  rig.cache.delivered = (sessionId, by, copies) => {
    recorded.push([...copies.values()]);
    record(sessionId, by, copies);
  };
  return {
    r: mainRenderer(parts, NO_PUSHES, NOTHING_STORED),
    parts,
    recorded,
    changed,
    logged,
    pipesAnswered,
    rig,
  };
}

// A statusline request for the rig's session, through the host's checkpoint.
// It passes a flag the client does not know, so its bar lists one error.
// `pane` is the tmux pane its client reports, if any.
function checked(pane?: string): CheckedRenderRequest {
  const configFile = path.join(dir, "config.json5");
  fs.writeFileSync(configFile, "{}");
  const { hookData } = requestOf(dir);
  const result = checkRenderRequest(
    {
      v: PROTOCOL_VERSION,
      kind: "render",
      hookData,
      args: ["cc-candybar", "--config", configFile, "--bogus"],
      cwd: PROJECT,
      encoding: "frame",
      env: TEST_ENV,
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

// The readings every input here carries: the rig's instant, at the first tick.
const READ = { at: AT, tick: 0 as Tick };

// The session's context as the host delivers one ahead of a request: with the
// world state its collector read at the request's keys.
const contextTurn = (
  { r, rig }: { r: Renderer; rig: SessionRig },
  context: CheckedRenderRequest,
) =>
  r.answer({
    kind: "event",
    ...READ,
    event: {
      kind: "context",
      context,
      worldState: rig.served.collector.requested(context, TEST_ENVIRONMENT),
    },
  });

// What the host's slot does after `output`: the config of each origin it
// names that the renderer holds none of, each its own turn, and the last
// output's subscriptions handed back to the collector. Answers that output.
const configsNamed = async (
  { r, rig }: { r: Renderer; rig: SessionRig },
  output: RendererOutput,
): Promise<RendererOutput> => {
  let last = output;
  for (const origin of output.subscriptions.configs) {
    if (rig.cache.holdsConfig(origin)) continue;
    rig.cache.configs.follow(origin);
    last = await r.answer({
      kind: "event",
      ...READ,
      event: {
        kind: "config",
        origin,
        config: rig.cache.configs.discovery.snapshotOf(origin)!,
      },
    });
  }
  rig.served.collector.subscribed(last.subscriptions);
  return last;
};

// The session's context, and the config it waits for.
const configure = async (
  t: { r: Renderer; rig: SessionRig },
  context: CheckedRenderRequest,
) => configsNamed(t, await contextTurn(t, context));

// The request as the host delivers one: after the session's config.
const request = async (t: { r: Renderer; rig: SessionRig }) => {
  const context = checked();
  await configure(t, context);
  return t.r.answer({
    kind: "event",
    ...READ,
    event: {
      kind: "request",
      id: REQUEST,
      context,
    },
  });
};

const handIn = (r: Renderer, event: Event) =>
  r.answer({ kind: "event", ...READ, event });

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
    ...READ,
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
  if (present?.kind !== "present")
    throw new Error("the turn presented nothing");
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
    // The turn's record is the draw's half of the render event.
    expect(new Map(record).has("at")).toBe(true);
  });

  // A restarted renderer: the host releases whatever its first output does
  // not name, a tmux status row included.
  test("of each live session is configured by a start's one turn and the config it names, whose output names them all", async () => {
    const t = renderer();
    const { r, rig } = t;
    const mine = checked();
    const other = sessionIdOf("other-session");
    const theirs: CheckedRenderRequest = {
      ...mine,
      hookData: { ...mine.hookData, session_id: other },
    };
    const output = await r.answer({
      kind: "event",
      ...READ,
      event: {
        kind: "start",
        viewers: {},
        sessions: [mine, theirs].map((context) => ({
          context,
          worldState: rig.served.collector.requested(context, TEST_ENVIRONMENT),
        })),
      },
    });
    expect(output.kind).toBe("answered");
    // Both wait for the one origin they share.
    expect(output.subscriptions.configs).toEqual([mine.requested]);
    const configured = await configsNamed(t, output);
    expect(configured.kind).toBe("answered");
    expect(Object.keys(configured.subscriptions.sources).sort()).toEqual(
      [SESSION, other].sort(),
    );
  });

  test("has its context's facts on its context turn's record, which opens with the session", async () => {
    const { record } = await contextTurn(renderer(), checked());
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
        ...READ,
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
      ...READ,
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
      ...READ,
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

describe("a draw", () => {
  // [LAW:effects-at-boundaries] What a draw made comes back as values, and
  // only the turn that drew it keeps them.
  test("drawn twice from the same state and instant is the same frame and memory, and leaves the renderer as it found it", async () => {
    const { r, parts, recorded, rig } = renderer();
    answered(await request({ r, rig }));
    const view = viewOf(rig)!;
    const record = view.frames.get("request");
    const cells = view.lastRenderCellsBySegment;
    const motion = parts.effectSessions.of(SESSION).lastFrame();
    const warned = parts.renderWarnings.of(SESSION, "request");
    const draw = () => {
      using setup = setUpRender(parts, checked(), READ, []);
      const { drawn, kept } = drawRender(
        parts,
        setup,
        ANSWERING,
        UNFOLLOWED_FEEDS,
      );
      return { drawn, kept };
    };
    const first = draw();
    const second = draw();
    expect(second.drawn).toEqual(first.drawn);
    expect(second.kept).toEqual(first.kept);
    expect(view.frames.get("request")).toBe(record);
    expect(view.lastRenderCellsBySegment).toBe(cells);
    expect(parts.effectSessions.of(SESSION).lastFrame()).toBe(motion);
    expect(parts.renderWarnings.of(SESSION, "request")).toBe(warned);
    expect(recorded).toEqual([]);
  });
});

describe("a feed's frame", () => {
  // [LAW:no-silent-failure] A feed's render that threw reaches a lane as a
  // Frame saying so, with no failure branch in the lane.
  test("whose render threw is the failure's Frame, a still bar in the error glyph's words, and its answers say so", () => {
    const parts = {
      renderCache: {
        holdView: () => null,
        openFailure: () => ({ error: new Error("the view would not open") }),
      },
    } as unknown as RendererParts;
    const frame = renderFrame(
      parts,
      SESSION,
      30,
      READ,
      new Set(["pane"]),
      UNFOLLOWED_FEEDS,
    )!;
    expect(frame.bar).toEqual(renderFailedFrame("the view would not open"));
    expect(frame.bar.nextChange).toBe(Infinity);
    expect(JSON.parse(frame.answers.resp)).toMatchObject({
      ok: false,
      code: "RENDER_FAILED",
      error: "the view would not open",
    });
    expect(frame.failure).not.toBeNull();
  });

  test("records what it showed as it is drawn, under the feed, apart from the request's", async () => {
    const { r, parts, recorded, rig } = renderer();
    answered(await request({ r, rig }));
    const by: string[] = [];
    const record = rig.cache.delivered.bind(rig.cache);
    rig.cache.delivered = (sessionId, drawer, copies) => {
      by.push(drawer);
      record(sessionId, drawer, copies);
    };
    const frame = renderFrame(
      parts,
      SESSION,
      MOVING_FPS,
      READ,
      new Set(),
      UNFOLLOWED_FEEDS,
    );
    expect(frame?.failure).toBeNull();
    expect(recorded).toEqual([[expect.stringMatching(/--bogus/)]]);
    expect(by).toEqual(["feed"]);
  });

  // [LAW:effects-at-boundaries] The record and transitions are a surface's
  // own; the animation clock is the session's, one for both.
  test("leaves the request's record of the view as it was, beside its own, under the session's one clock", async () => {
    const { r, parts, rig } = renderer();
    answered(await request({ r, rig }));
    const view = viewOf(rig)!;
    const answeredRecord = view.frames.get("request");
    expect(answeredRecord).toBeDefined();
    renderFrame(parts, SESSION, MOVING_FPS, READ, new Set(), UNFOLLOWED_FEEDS);
    expect(view.frames.get("request")).toBe(answeredRecord);
    expect(view.frames.get("feed")).toBeDefined();
    expect(view.frames.get("feed")).not.toBe(answeredRecord);
    expect(parts.effectSessions.getStats().sessions).toBe(1);
  });

  // A frame that fails as it leaves the renderer reached no lane, so the
  // next frame compares against the last one that did.
  test("that fails after its draw keeps none of what the draw made", async () => {
    const { r, parts, rig } = renderer();
    answered(await request({ r, rig }));
    const view = viewOf(rig)!;
    const motion = parts.effectSessions.of(SESSION).lastFrame();
    const failing: RendererParts = {
      ...parts,
      linkSigner: {
        ...parts.linkSigner,
        signLink: () => {
          throw new Error("the signer is gone");
        },
      },
    };
    const frame = renderFrame(
      failing,
      SESSION,
      MOVING_FPS,
      READ,
      new Set(),
      UNFOLLOWED_FEEDS,
    );
    expect(frame?.failure).not.toBeNull();
    expect(view.frames.get("feed")).toBeUndefined();
    expect(parts.effectSessions.of(SESSION).lastFrame()).toBe(motion);
  });

  // A feed that opens again draws its first frame, fading nothing in from
  // what the closed one last showed.
  test("whose feed closed leaves no record of it, and the request's stands", async () => {
    const { r, parts, rig } = renderer();
    answered(await request({ r, rig }));
    const view = viewOf(rig)!;
    renderFrame(parts, SESSION, MOVING_FPS, READ, new Set(), UNFOLLOWED_FEEDS);
    expect(view.frames.get("feed")).toBeDefined();
    parts.renderCache.stopDrawing(SESSION, "feed");
    expect(view.frames.get("feed")).toBeUndefined();
    expect(view.frames.get("request")).toBeDefined();
  });

  // A wake while a frame is out is owed a frame after it, so a draw that woke
  // its own feed would keep a still bar drawing at the moving rate.
  test("moves nothing its feed wakes for: neither the view's data nor the session's state", async () => {
    const { r, parts, changed, rig } = renderer();
    answered(await request({ r, rig }));
    const draw = (at: Instant) =>
      renderFrame(
        parts,
        SESSION,
        MOVING_FPS,
        { at, tick: 0 as Tick },
        new Set(),
        UNFOLLOWED_FEEDS,
      );
    const changedBefore = changed.length;
    const revision = rig.sessionState.latestRevision();
    expect(draw(AT)?.failure).toBeNull();
    expect(draw((AT + 1) as Instant)?.failure).toBeNull();
    expect(changed.slice(changedBefore)).toEqual([]);
    expect(rig.sessionState.latestRevision()).toBe(revision);
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
    expect(subscriptions.lanes[other]).toBeUndefined();
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
    // Its origin's config is held, so the context opens the view itself.
    await configure(t, checked());
    t.rig.cache.holdSession = (() => {
      throw new Error("the opening broke");
    }) as never;
    const kinds: string[] = [];
    const host = rendererHost(
      MAIN_RENDERER,
      systemTimekeeper,
      hostHeld(hearingEvents(t.r, (input) => kinds.push(input.event.kind))),
      () => {},
      unfollowedCollector(t.rig.served.collector),
      { ...NO_ACTS, configs: t.rig.cache.configs.discovery },
    );
    const facts: Array<readonly [string, string]> = [];
    const answered = await answerStatusline(
      host,
      t.rig.served.collector,
      systemTimekeeper,
      new AbortController().signal,
      () => {},
      checkoutLocation,
      checked(),
      TEST_ENVIRONMENT,
      REQUEST,
      systemTimekeeper.monotonic() + 5000,
      facts as never,
    );
    expect(kinds).toEqual(["context", "config"]);
    expect(answered.resp).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /^renderer main: its context turn: the opening broke/,
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
      ...READ,
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
});

describe("an event that waits for its origin's config", () => {
  test("a context at an origin the renderer holds no config for parks, its output names the origin, and the config turn opens its view", async () => {
    const t = renderer();
    const context = checked();
    const parked = answered(await contextTurn(t, context));
    expect(parked.subscriptions.configs).toEqual([context.requested]);
    expect(parked.subscriptions.sources).toEqual({});
    expect(new Map(parked.record).get("parked")).toBe("context");
    expect(viewOf(t.rig)).toBeNull();
    const configured = answered(await configsNamed(t, parked));
    expect(viewOf(t.rig)).not.toBeNull();
    expect(Object.keys(configured.subscriptions.sources)).toEqual([SESSION]);
  });

  test("a world state handed in while its context is parked is taken in its order, and the config turn opens the view at it", async () => {
    const t = renderer();
    const parked = answered(await contextTurn(t, checked()));
    const held = t.rig.served.worldStates.of(SESSION);
    const next = { ...held, seq: held.seq + 1 };
    answered(await handIn(t.r, { kind: "world-state", worldState: next }));
    answered(await configsNamed(t, parked));
    expect(viewOf(t.rig)?.source.facts()).toBe(next);
  });

  test("a parked context its session retired before the config came opens nothing, and the origin is let go", async () => {
    const t = renderer();
    const context = checked();
    answered(await contextTurn(t, context));
    const retired = answered(
      await handIn(t.r, { kind: "retire", session: SESSION }),
    );
    expect(retired.subscriptions.configs).toEqual([]);
    t.rig.cache.configs.follow(context.requested);
    answered(
      await handIn(t.r, {
        kind: "config",
        origin: context.requested,
        config: t.rig.cache.configs.discovery.snapshotOf(context.requested)!,
      }),
    );
    expect(viewOf(t.rig)).toBeNull();
  });

  // A session retires when idle, and the entry stays to draw it again, so
  // the config it loads from stays current.
  test("a retired session's origin stays named while the cache entry it loaded lives", async () => {
    const t = renderer();
    const context = checked();
    await configure(t, context);
    const retired = answered(
      await handIn(t.r, { kind: "retire", session: SESSION }),
    );
    expect(retired.subscriptions.configs).toEqual([context.requested]);
    expect(t.rig.cache.holdsConfig(context.requested)).toBe(true);
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
      MAIN_RENDERER,
      systemTimekeeper,
      hostHeld(
        hearingEvents(t.r, (input) => {
          if (input.event.kind === "context")
            requests.push(input.event.worldState);
        }),
      ),
      () => {},
      unfollowedCollector(t.rig.served.collector),
      { ...NO_ACTS, configs: t.rig.cache.configs.discovery },
    );
    t.rig.served.route(host);
    const ask = (pane: string, id: number) =>
      answerStatusline(
        host,
        t.rig.served.collector,
        systemTimekeeper,
        new AbortController().signal,
        () => {},
        checkoutLocation,
        checked(pane),
        TEST_ENVIRONMENT,
        id as RequestId,
        systemTimekeeper.monotonic() + 10_000,
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
    live: CheckedRenderRequest | null = null,
  ): Event => ({
    kind: "click",
    verb,
    value: "",
    session: { ok: true, id: SESSION },
    arrival: { via: "link", delivery: { kind: "cli" } },
    context: live === null ? null : heardContextOf(live),
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
    let seen: SessionContext | null | undefined;
    const t = renderer({
      ...NO_VERBS,
      handler: (verb) =>
        verb === "act"
          ? (_value, facts) => {
              seen = facts.context;
            }
          : undefined,
      closeIdle: () => {
        throw new Error("no idle close here");
      },
    });
    await request(t);
    await handIn(t.r, { kind: "retire", session: SESSION });
    const latest = checked("%3");
    // The entry its request loaded still names the origin, so the click's
    // config is held and it runs in its own turn.
    answered(await handIn(t.r, click("act", latest)));
    expect(seen).toEqual(heardContextOf(latest));
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

describe("the idle close", () => {
  test("closes, in a due turn, the menus of each session idle past its timeout, with no effect", async () => {
    const closed: Array<[string, number]> = [];
    const t = renderer({
      ...NO_VERBS,
      handler: () => undefined,
      closeIdle: (sessionId, _latest, { idleS }) => {
        closed.push([sessionId, idleS]);
      },
    });
    t.parts.menuIdle.drew(SESSION, 0 as Tick, true, 30);
    const due = (tick: number) =>
      t.r.answer({
        kind: "event",
        at: AT,
        tick: tick as Tick,
        event: { kind: "due" },
      });
    expect(answered(await due(29)).effects).toEqual([]);
    expect(closed).toEqual([]);
    const { effects, subscriptions } = answered(await due(30));
    expect(effects).toEqual([]);
    expect(closed).toEqual([[SESSION, 30]]);
    // Taken as closed: no close is due until a draw shows a menu again.
    expect(subscriptions.wake).toBeNull();
    expect(answered(await due(1000)).effects).toEqual([]);
    expect(closed).toHaveLength(1);
  });
});
