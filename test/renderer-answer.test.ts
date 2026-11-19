// The main renderer answers a statusline request through `answer` alone
// (src/renderer-interface/interface.ts): the request's turn returns one `present` for
// the statusline, carrying the request it answers and the frame drawn, and the
// present's `effect-done` is what records what the frame showed. A world state
// the host hands in is what its session's view draws from, a retire closes the
// view, and every output says what the open views need read. A due feed frame
// also has a receipt whose `effect-done` records only an accepted delivery.
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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROTOCOL_VERSION,
  type ReaderRenderRequest,
} from "../src/daemon/foundations/protocol";
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
  type Delivery,
  type RendererParts,
} from "../src/renderer/draw-bar";
import { FEED_PERIODS, Feeds } from "../src/renderer/feeds";
import { renderWidth } from "../src/renderer/render-payload";
import { parseFrame, textOf } from "../src/render/frame";
import { MAX_VIEWER_ROWS } from "../src/render/diagnostics";
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
import { rendererHost, type HostWorld } from "../src/daemon/renderer-host";
import type {
  MainRendererParts,
  RendererVerbs,
} from "../src/renderer/verbs/port";
import { answerStatusline } from "../src/daemon/statusline-answer";
import { publishingFrames } from "../src/daemon/foundations/frame-publication";
import { TEST_SIGNER } from "./helpers/link-signer";
import { linksOf } from "../src/click/read";
import { isBarLink } from "../src/click/wire";
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
    feeds: new Feeds({
      draw: (session, fps, readings, following, lanes, prepare) =>
        renderFrame(parts, session, fps, readings, following, lanes, prepare),
      pin: (session) => rig.cache.pin(session),
      log: (level, message) => logged.push(`${level} ${message}`),
      periods: FEED_PERIODS,
    }),
    eventAnswered: (event) => pipesAnswered.push(event),
  };
  cleanups.push(() => parts.feeds.closeAll(READ.tick));
  // The cache's record of a delivered frame, heard on its way in.
  const recorded: string[][] = [];
  const accept = rig.cache.acceptFrame.bind(rig.cache);
  rig.cache.acceptFrame = (id, candidate) => {
    const result = accept(id, candidate);
    if (result !== null) recorded.push([...candidate.frame.copies.values()]);
    return result;
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
function checked(
  pane?: string,
  file = "config.json5",
  terminal: Pick<ReaderRenderRequest, "termCols" | "termRows"> = {},
): CheckedRenderRequest {
  const configFile = path.join(dir, file);
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
      ...terminal,
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
const request = async (
  t: { r: Renderer; rig: SessionRig },
  readings = READ,
) => {
  const context = checked();
  await configure(t, context);
  return t.r.answer({
    kind: "event",
    ...readings,
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

function presentation(rig: SessionRig, by: "request" | "feed") {
  const view = viewOf(rig);
  return view === null
    ? undefined
    : rig.cache.presentations.layout(SESSION, by, view.presentationTargets[by]);
}

const done = (
  r: Renderer,
  { session, id: of }: Pick<Effect, "session" | "id">,
  ok: boolean,
) =>
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

const followFeed = (r: Renderer) =>
  handIn(r, {
    kind: "viewers",
    viewers: {
      [SESSION]: {
        lanes: { statusline: { subscribers: 1, drawing: true } },
        shown: true,
        joined: 1,
      },
    },
  });

async function dueFrame(r: Renderer, elapsed = 0) {
  const { frames } = answered(
    await r.answer({
      kind: "event",
      at: (READ.at + elapsed) as Instant,
      tick: (READ.tick + elapsed) as Tick,
      event: { kind: "due" },
    }),
  );
  expect(frames).toHaveLength(1);
  const pushed = frames[0];
  if (pushed?.frame.kind !== "drawn") throw new Error("the feed drew no bar");
  expect(pushed.session).toBe(SESSION);
  return pushed.frame;
}

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

  test("a dropped statusline reply preserves the last delivered layout and segment cells", async () => {
    const t = renderer();
    const first = presentOf(answered(await request(t)).effects);
    expect(presentation(t.rig, "request")).toBeUndefined();
    await done(t.r, first, true);
    const record = presentation(t.rig, "request");
    const segments = presentation(t.rig, "request")?.segments;
    expect(record).toBeDefined();
    const next = presentOf(answered(await request(t)).effects);
    expect(presentation(t.rig, "request")).toBe(record);
    await done(t.r, next, false);
    expect(presentation(t.rig, "request")).toBe(record);
    expect(presentation(t.rig, "request")?.segments).toBe(segments);
  });

  test("a late statusline receipt cannot replace a newer delivered frame", async () => {
    const t = renderer();
    const older = presentOf(answered(await request(t)).effects);
    const newer = presentOf(answered(await request(t)).effects);
    answered(await done(t.r, newer, true));
    const accepted = presentation(t.rig, "request");
    expect(accepted).toBeDefined();
    answered(await done(t.r, older, true));
    expect(presentation(t.rig, "request")).toBe(accepted);
    expect(t.recorded).toHaveLength(1);
  });

  test("a late confirmed statusline frame can establish the record after a newer write failed", async () => {
    const t = renderer();
    const older = presentOf(answered(await request(t)).effects);
    const newer = presentOf(answered(await request(t)).effects);
    answered(await done(t.r, newer, false));
    expect(presentation(t.rig, "request")).toBeUndefined();
    answered(await done(t.r, older, true));
    expect(presentation(t.rig, "request")).toBeDefined();
    expect(t.recorded).toHaveLength(1);
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
    const present = presentOf(answered(await request({ r, rig })).effects);
    await done(r, present, true);
    const deliveries = recorded.length;
    const record = presentation(rig, "request");
    const cells = presentation(rig, "request")?.segments;
    const motion = parts.renderCache.presentations.effects(SESSION).lastFrame();
    const warned = parts.renderCache.presentations.diagnostics(
      SESSION,
      "request",
    );
    const draw = () => {
      using setup = setUpRender(parts, checked(), READ, []);
      const { drawn, candidate } = drawRender(
        parts,
        setup,
        ANSWERING,
        UNFOLLOWED_FEEDS,
      );
      return { drawn, candidate };
    };
    const first = draw();
    const second = draw();
    expect(second.drawn).toEqual(first.drawn);
    expect(second.candidate).toEqual(first.candidate);
    expect(presentation(rig, "request")).toBe(record);
    expect(presentation(rig, "request")?.segments).toBe(cells);
    expect(parts.renderCache.presentations.effects(SESSION).lastFrame()).toBe(
      motion,
    );
    expect(
      parts.renderCache.presentations.diagnostics(SESSION, "request"),
    ).toBe(warned);
    expect(recorded).toHaveLength(deliveries);
  });
});

describe("a feed's frame", () => {
  test("whose render threw names the failure for the host to publish", () => {
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
      () => {
        throw new Error("a failed draw requested a receipt");
      },
    )!;
    expect(frame.frame).toEqual({
      kind: "failed",
      message: "the view would not open",
    });
    expect(frame.failure).not.toBeNull();
  });

  test("a due frame records its shown copies only after its receipt is accepted", async () => {
    const t = renderer();
    const { r, recorded, rig } = t;
    await configure(t, checked());
    const by: string[] = [];
    const accept = rig.cache.acceptFrame.bind(rig.cache);
    rig.cache.acceptFrame = (id, candidate) => {
      const result = accept(id, candidate);
      if (result !== null) by.push(candidate.by);
      return result;
    };
    answered(await followFeed(r));
    const frame = await dueFrame(r);
    expect(recorded).toEqual([]);
    expect(presentation(rig, "feed")).toBeUndefined();
    const delivered = answered(
      await done(r, { session: SESSION, id: frame.receipt }, true),
    );
    expect(delivered.record).toContainEqual([
      "faults",
      expect.stringContaining("--bogus"),
    ]);
    expect(recorded).toEqual([[expect.stringMatching(/--bogus/)]]);
    expect(by).toEqual(["feed"]);
    const same = await dueFrame(r, 1);
    const confirmed = answered(
      await done(r, { session: SESSION, id: same.receipt }, true),
    );
    expect(confirmed.record).toEqual([]);
  });

  // [LAW:effects-at-boundaries] The record and transitions are a surface's
  // own; the animation clock is the session's, one for both.
  test("leaves the request's record of the view as it was, beside its own, under the session's one clock", async () => {
    const { r, parts, rig } = renderer();
    const present = presentOf(answered(await request({ r, rig })).effects);
    await done(r, present, true);
    const answeredRecord = presentation(rig, "request");
    expect(answeredRecord).toBeDefined();
    answered(await followFeed(r));
    const frame = await dueFrame(r);
    expect(presentation(rig, "feed")).toBeUndefined();
    answered(await done(r, { session: SESSION, id: frame.receipt }, true));
    expect(presentation(rig, "request")).toBe(answeredRecord);
    const feedRecord = presentation(rig, "feed");
    expect(feedRecord).toBeDefined();
    expect(feedRecord).not.toBe(answeredRecord);
    const nextRequest = presentOf(answered(await request({ r, rig })).effects);
    answered(await done(r, nextRequest, true));
    expect(presentation(rig, "feed")).toBe(feedRecord);
    expect(parts.renderCache.presentations.stats().effects.sessions).toBe(1);
  });

  test("an older feed receipt keeps its layout without rewinding the newer request's motion", async () => {
    const t = renderer();
    const initial = presentOf(answered(await request(t)).effects);
    answered(await done(t.r, initial, true));
    answered(await followFeed(t.r));
    const feed = await dueFrame(t.r, 1);
    const requestFrame = presentOf(
      answered(
        await request(t, {
          at: (READ.at + 3) as Instant,
          tick: (READ.tick + 3) as Tick,
        }),
      ).effects,
    );
    answered(await done(t.r, requestFrame, true));
    const motion = t.rig.cache.presentations.effects(SESSION).lastFrame();
    expect(motion.t).toBe(3);
    const requestLayout = presentation(t.rig, "request");

    answered(await done(t.r, { session: SESSION, id: feed.receipt }, true));
    expect(presentation(t.rig, "feed")).toBeDefined();
    expect(presentation(t.rig, "request")).toBe(requestLayout);
    expect(t.rig.cache.presentations.effects(SESSION).lastFrame()).toBe(motion);
  });

  test("a dropped frame preserves the last accepted layout, cells and copies", async () => {
    const t = renderer();
    const context = checked();
    fs.writeFileSync(
      path.join(dir, "config.json5"),
      JSON.stringify({
        variables: {
          modelName: {
            kind: "input",
            path: "model.display_name",
            type: "string",
          },
        },
        segments: {
          base: { template: "BASE" },
          added: { template: "ADDED", when: '{{ eq .modelName "expanded" }}' },
        },
        root: { h: ["base", "added"] },
      }),
    );
    await configure(t, context);
    answered(await followFeed(t.r));
    const first = await dueFrame(t.r);
    expect(textOf(parseFrame(first.bar))).not.toContain("ADDED");
    answered(await done(t.r, { session: SESSION, id: first.receipt }, true));
    const view = viewOf(t.rig)!;
    const prior = presentation(t.rig, "feed");
    expect(prior).toBeDefined();
    const deliveries = t.recorded.length;

    await configure(t, {
      ...context,
      hookData: {
        ...context.hookData,
        model: { id: "fixture", display_name: "expanded" },
      },
    });
    const next = await dueFrame(t.r, 2);
    expect(textOf(parseFrame(next.bar))).toContain("ADDED");
    expect(viewOf(t.rig)).toBe(view);
    expect(presentation(t.rig, "feed")).toBe(prior);
    answered(await done(t.r, { session: SESSION, id: next.receipt }, false));
    expect(presentation(t.rig, "feed")).toBe(prior);
    expect(presentation(t.rig, "feed")?.segments).toBe(prior?.segments);
    expect(t.recorded).toHaveLength(deliveries);
  });

  test("draws unsigned clickable addresses for the host to publish", async () => {
    const t = renderer();
    await configure(t, checked());
    answered(await followFeed(t.r));
    const frame = await dueFrame(t.r);
    const links = linksOf(parseFrame(frame.bar)).filter(({ url }) =>
      isBarLink(url),
    );
    expect(links.length).toBeGreaterThan(0);
    for (const { url } of links)
      expect(TEST_SIGNER.openLink(url)).toMatchObject({
        kind: "failed",
        reason: expect.stringContaining("no signature"),
      });
    answered(await done(t.r, { session: SESSION, id: frame.receipt }, false));
  });

  // A feed that opens again draws its first frame, fading nothing in from
  // what the closed one last showed.
  test("whose feed closed leaves no record of it, and the request's stands", async () => {
    const { r, parts, rig } = renderer();
    const present = presentOf(answered(await request({ r, rig })).effects);
    await done(r, present, true);
    answered(await followFeed(r));
    const frame = await dueFrame(r);
    answered(await done(r, { session: SESSION, id: frame.receipt }, true));
    expect(presentation(rig, "feed")).toBeDefined();
    const pending = await dueFrame(r, 1);
    parts.renderCache.stopDrawing(SESSION, "feed");
    answered(await done(r, { session: SESSION, id: pending.receipt }, true));
    expect(presentation(rig, "feed")).toBeUndefined();
    expect(presentation(rig, "request")).toBeDefined();
  });

  // A wake while a frame is out is owed a frame after it, so a draw that woke
  // its own feed would keep a still bar drawing at the moving rate.
  test("moves nothing its feed wakes for: neither the view's data nor the session's state", async () => {
    const { r, parts, changed, rig } = renderer();
    answered(await request({ r, rig }));
    const candidates: Delivery[] = [];
    const draw = (at: Instant) =>
      renderFrame(
        parts,
        SESSION,
        MOVING_FPS,
        { at, tick: 0 as Tick },
        new Set(),
        UNFOLLOWED_FEEDS,
        (candidate) => {
          candidates.push(candidate);
          return parts.mint();
        },
      );
    const changedBefore = changed.length;
    const revision = rig.sessionState.latestRevision();
    expect(draw(AT)?.failure).toBeNull();
    expect(draw((AT + 1) as Instant)?.failure).toBeNull();
    expect(candidates).toHaveLength(2);
    expect(presentation(rig, "feed")).toBeUndefined();
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

  test("a failed teardown retires the session until another context admits it", async () => {
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
    const late = answered(
      await handIn(t.r, { kind: "world-state", worldState: held }),
    );
    expect(late.record).toContainEqual(["world-state", "no-live-session"]);
    expect(() => t.rig.served.worldStates.of(SESSION)).toThrow(
      /no world state for session/,
    );
    // A new context can start below the seq the retired document had.
    answered(
      await handIn(t.r, {
        kind: "context",
        context: checked(),
        worldState: held,
      }),
    );
    expect(t.rig.served.worldStates.of(SESSION)).toBe(held);
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

// The real host/renderer ordering with the test's config discovery on the
// host side. A barrier finishes any acknowledgement queued by the caller.
function productionAnswer(
  t: ReturnType<typeof renderer>,
  seen: Event[],
  override: Partial<Pick<HostWorld["configs"], "follow" | "snapshotOf">> = {},
  closing = new AbortController().signal,
) {
  const { discovery } = t.rig.cache.configs;
  const host = rendererHost(
    MAIN_RENDERER,
    systemTimekeeper,
    hostHeld(
      hearingEvents(t.r, ({ event }) => {
        if (event.kind !== "viewers") seen.push(event);
      }),
    ),
    () => {},
    unfollowedCollector(t.rig.served.collector),
    {
      ...NO_ACTS,
      unheard: (text) => void t.logged.push(text),
      configs: {
        ...NO_ACTS.configs,
        follow: discovery.follow.bind(discovery),
        snapshotOf: discovery.snapshotOf.bind(discovery),
        ...override,
      },
    },
  );
  return Object.assign(
    () =>
      answerStatusline(
        host,
        publishingFrames(TEST_SIGNER),
        t.rig.served.collector,
        systemTimekeeper,
        closing,
        () => {},
        checkoutLocation,
        checked(),
        TEST_ENVIRONMENT,
        REQUEST,
        systemTimekeeper.monotonic() + 5000,
        [],
      ),
    {
      drain: () =>
        host.answer(() => ({
          kind: "event",
          event: { kind: "viewers", viewers: {} },
        })),
    },
  );
}

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
      publishingFrames(TEST_SIGNER),
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

  test("a cold render waits for config in its context slot, then owns one present and acknowledgement", async () => {
    const t = renderer();
    const seen: Event[] = [];
    const ask = productionAnswer(t, seen);
    const reply = await ask();
    expect(reply.resp.ok).toBe(true);

    expect(seen.map((event) => event.kind)).toEqual([
      "context",
      "config",
      "request",
    ]);
    expect(seen.at(-1)).toMatchObject({ id: REQUEST });
    reply.settled(true);
    await ask.drain();
    expect(seen.filter((event) => event.kind === "effect-done")).toEqual([
      expect.objectContaining({
        kind: "effect-done",
        session: SESSION,
        outcome: { kind: "ok" },
      }),
    ]);
    expect(t.recorded).toHaveLength(1);
  });

  test("a failed config ends the original cold render before it waits or draws", async () => {
    const t = renderer();
    t.rig.cache.configure = () => {
      throw new Error("config load broke");
    };
    const waits = jest.spyOn(t.rig.served.collector, "settled");
    const seen: Event[] = [];
    const ask = productionAnswer(t, seen);
    const reply = await ask();
    expect(reply.resp).toMatchObject({
      ok: false,
      error: "renderer main: its config turn: config load broke",
    });
    reply.settled(true);
    await ask.drain();
    expect(seen.map((event) => event.kind)).toEqual(["context", "config"]);
    expect(waits).not.toHaveBeenCalled();
    expect(t.recorded).toEqual([]);
  });

  test("closing during preparation ends the request without a present", async () => {
    const t = renderer();
    const { discovery } = t.rig.cache.configs;
    const seen: Event[] = [];
    const closing = new AbortController();
    const ask = productionAnswer(
      t,
      seen,
      {
        snapshotOf: (origin) => {
          closing.abort();
          return discovery.snapshotOf(origin);
        },
      },
      closing.signal,
    );
    const reply = await ask();
    expect(reply.resp).toMatchObject({
      ok: false,
      error: "renderer main: the daemon closed: render refused",
    });
    reply.settled(true);
    await ask.drain();
    expect(seen.map((event) => event.kind)).toEqual(["context", "config"]);
    expect(t.recorded).toEqual([]);
  });

  test("a config discovery failure answers the first request and the next request can configure", async () => {
    const t = renderer();
    const { discovery } = t.rig.cache.configs;
    const seen: Event[] = [];
    let first = true;
    const ask = productionAnswer(t, seen, {
      follow: (origins) => {
        if (first) {
          first = false;
          throw new Error("config discovery broke");
        }
        discovery.follow(origins);
      },
    });
    const reply = await ask();
    expect(reply.resp).toMatchObject({
      ok: false,
      error: "renderer main: its config turn: config discovery broke",
    });
    expect(seen.map((event) => event.kind)).toEqual(["context"]);
    const ready = await ask();
    expect(ready.resp.ok).toBe(true);
    ready.settled(false);
    await ask.drain();
    expect(seen.map((event) => event.kind)).toEqual([
      "context",
      "context",
      "config",
      "request",
      "effect-done",
    ]);
    expect(t.recorded).toEqual([]);
  });

  test("a snapshot that never reached the renderer can be served at the next context", async () => {
    const t = renderer();
    const { discovery } = t.rig.cache.configs;
    const seen: Event[] = [];
    let attempts = 0;
    const ask = productionAnswer(t, seen, {
      snapshotOf: (origin) => {
        if (++attempts === 1) {
          throw new Error("config snapshot could not be sent");
        }
        return discovery.snapshotOf(origin);
      },
    });
    const reply = await ask();
    expect(reply.resp).toMatchObject({
      ok: false,
      error:
        "renderer main: its config turn: config snapshot could not be sent",
    });
    expect(seen.map((event) => event.kind)).toEqual(["context"]);
    await ask.drain();
    expect(attempts).toBe(1);
    const ready = await ask();
    expect(ready.resp.ok).toBe(true);
    ready.settled(true);
    await ask.drain();
    expect(seen.map((event) => event.kind)).toEqual([
      "context",
      "context",
      "config",
      "request",
      "effect-done",
    ]);
    expect(attempts).toBe(2);
    expect(t.recorded).toHaveLength(1);
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

  test("a premature request owns no present and a later request is answered in its own turn", async () => {
    const t = renderer();
    const context = checked();
    const waiting = answered(await contextTurn(t, context));
    const request = { kind: "request", id: REQUEST, context } as const;
    const early = threw(await handIn(t.r, request));
    expect(early.failure.message).toMatch(/config is pending for session/);
    expect(early.effects).toEqual([]);

    const configured = answered(await configsNamed(t, waiting));
    expect(configured.effects).toEqual([]);
    const drawn = answered(await handIn(t.r, request));
    const present = presentOf(drawn.effects);
    expect(present.request).toBe(REQUEST);
    answered(await done(t.r, present, true));
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

  test("config arriving for a previous origin leaves the opening at the newest context", async () => {
    const t = renderer();
    const first = checked("%1", "first.json5");
    const current = checked("%2");
    const firstWaiting = answered(await contextTurn(t, first));
    const currentWaiting = answered(await contextTurn(t, current));
    expect(currentWaiting.subscriptions.configs).toEqual([current.requested]);

    answered(await configsNamed(t, firstWaiting));
    expect(viewOf(t.rig)).toBeNull();

    answered(await configsNamed(t, currentWaiting));
    expect(viewOf(t.rig)?.facts()).toBe(current);
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
    const drawings: RequestId[] = [];
    const host = rendererHost(
      MAIN_RENDERER,
      systemTimekeeper,
      hostHeld(
        hearingEvents(t.r, (input) => {
          if (input.event.kind === "context")
            requests.push(input.event.worldState);
          if (input.event.kind === "request") drawings.push(input.event.id);
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
        publishingFrames(TEST_SIGNER),
        t.rig.served.collector,
        systemTimekeeper,
        new AbortController().signal,
        () => {},
        checkoutLocation,
        checked(pane, `${id}.json5`),
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
    for (const answer of answered) {
      expect(answer.resp).toMatchObject({ ok: true });
      answer.settled(true);
    }
    expect([...drawings].sort()).toEqual([1, 2]);
    const view = viewOf(t.rig)!;
    expect(view.facts().hints.tmux?.pane).toBe("%2");
    expect(view.source.facts().builtins.tmux).toMatchObject({
      kind: "ok",
      value: { session: "on %2" },
    });
  });
});

test("overlapping requests draw the latest pane with each client's width, then a feed and a regular request use the live width", async () => {
  const t = renderer();
  const narrow = checked("%1", "config.json5", { termCols: 80, termRows: 4 });
  const wide = checked("%2", "config.json5", { termCols: 200, termRows: 18 });
  if (wide.requested.target.path === undefined)
    throw new Error("test needs a config file");
  fs.writeFileSync(
    wide.requested.target.path,
    `{
    globals: { autoWrap: true },
    variables: {
      paneSession: { kind: "input", path: "tmux.session", default: "unknown" },
      width: { kind: "template", template: "{{ .term.cols }}" },
    },
    segments: {
      geometry: { template: "width={{ .width }} pane={{ .tmux.pane }} world={{ .paneSession }}" },
      longA: { template: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      longB: { template: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    },
    root: { h: ["geometry", "longA", "longB"] },
  }`,
  );

  // The test releases the older request last, after the newer pane's read.
  const landings = new Map<string, () => void>();
  const tmux = fakeTmux(
    (_holds, hint) =>
      new Promise((resolve) =>
        landings.set(hint.pane, () => resolve(ok(`on ${hint.pane}`))),
      ),
  );
  t.rig.providers.tmuxService.declare = tmux.declare as never;
  const contexts: WorldState[] = [];
  const drawings: RequestId[] = [];
  const collector = t.rig.served.collector;
  const host = rendererHost(
    MAIN_RENDERER,
    systemTimekeeper,
    hostHeld(
      hearingEvents(t.r, ({ event }) => {
        if (event.kind === "context") contexts.push(event.worldState);
        if (event.kind === "request") drawings.push(event.id);
      }),
    ),
    () => {},
    unfollowedCollector(collector),
    { ...NO_ACTS, configs: t.rig.cache.configs.discovery },
  );
  t.rig.served.route(host);
  let resumeOlder = (): void => {};
  const olderCanDraw = new Promise<void>((resolve) => {
    resumeOlder = resolve;
  });
  let olderSourcesReady = false;
  const earlierCollector = {
    requested: collector.requested.bind(collector),
    holding: collector.holding.bind(collector),
    settled: async (...args: Parameters<typeof collector.settled>) => {
      await collector.settled(...args);
      olderSourcesReady = true;
      await olderCanDraw;
    },
  };
  const ask = (
    context: CheckedRenderRequest,
    id: number,
    sources: typeof earlierCollector,
  ) =>
    answerStatusline(
      host,
      publishingFrames(TEST_SIGNER),
      sources,
      systemTimekeeper,
      new AbortController().signal,
      () => {},
      checkoutLocation,
      context,
      TEST_ENVIRONMENT,
      id as RequestId,
      systemTimekeeper.monotonic() + 10_000,
      [],
    );

  const first = ask(narrow, 1, earlierCollector);
  const second = ask(wide, 2, collector);
  await new Promise((resolve) => setImmediate(resolve));
  expect(contexts.map((w) => w.builtins.tmux.kind)).toEqual([
    "pending",
    "pending",
  ]);
  landings.get("%1")!();
  await new Promise((resolve) => setImmediate(resolve));
  expect(olderSourcesReady).toBe(false);
  landings.get("%2")!();
  const newer = await second;
  resumeOlder();
  const older = await first;
  expect(drawings).toEqual([2, 1]);
  const expectFrame = (resp: typeof newer.resp) => {
    if (!resp.ok || !("frame" in resp))
      throw new Error(`expected a frame: ${JSON.stringify(resp)}`);
    return parseFrame(resp.frame);
  };
  const wideFrame = expectFrame(newer.resp);
  const narrowFrame = expectFrame(older.resp);
  const label = (request: CheckedRenderRequest) =>
    `width=${renderWidth(request.hints)} pane=%2 world=on %2`;
  expect(textOf(narrowFrame)).toContain(label(narrow));
  expect(textOf(wideFrame)).toContain(label(wide));
  expect(narrowFrame.rows.length).toBeGreaterThan(wideFrame.rows.length);
  for (const answer of [newer, older]) answer.settled(true);

  const view = viewOf(t.rig)!;
  expect(view.facts().hints).toMatchObject({
    tmux: { pane: "%2" },
    termCols: 200,
  });
  expect(view.source.facts().builtins.tmux).toMatchObject({
    kind: "ok",
    value: { session: "on %2" },
  });
  expect(view.source.payload().term.cols).toBe(renderWidth(wide.hints));
  answered(await followFeed(t.r));
  const feed = await dueFrame(t.r);
  expect(textOf(parseFrame(feed.bar))).toContain(label(wide));
  answered(await done(t.r, { session: SESSION, id: feed.receipt }, true));

  const again = await ask(wide, 3, collector);
  expect(textOf(expectFrame(again.resp))).toContain(label(wide));
  again.settled(true);
});

test("diagnostics use the requesting client's rows or its own default ceiling", async () => {
  const t = renderer();
  const current = checked(undefined, "config.json5", { termRows: 18 });
  await configure(t, current);
  for (const [terminal, rows] of [
    [{ termRows: 4 }, 4],
    [{}, MAX_VIEWER_ROWS],
  ] as const) {
    using setup = setUpRender(t.parts, current, READ, [], terminal);
    const { drawn } = drawRender(t.parts, setup, ANSWERING, UNFOLLOWED_FEEDS);
    expect(drawn.geometry.rows).toBe(rows);
  }
});

describe("a click", () => {
  // A click on the rig's session's link, delivered by the CLI.
  const click = (
    verb: string,
    live: CheckedRenderRequest | null = null,
  ): Event => ({
    kind: "click",
    click: { scope: "session", verb, session: SESSION, steps: [] },
    arrival: { via: "link", delivery: { kind: "cli" } },
    context: live === null ? null : heardContextOf(live),
  });

  test("a parked click waits for the current origin and reads its latest context", async () => {
    const seen: Array<SessionContext | null> = [];
    const t = renderer({
      ...NO_VERBS,
      click: (_click, facts) => void seen.push(facts.context),
    });
    const first = checked("%1", "first.json5");
    const current = checked("%2");
    const firstWaiting = answered(await contextTurn(t, first));
    const waiting = answered(await handIn(t.r, click("act")));
    expect(waiting.record).toContainEqual(["parked", "click"]);

    const currentWaiting = answered(await contextTurn(t, current));
    answered(await configsNamed(t, firstWaiting));
    expect(seen).toEqual([]);
    answered(await configsNamed(t, currentWaiting));
    expect(seen).toEqual([heardContextOf(current)]);
  });

  test("failed config settles parked clicks and a later config does not replay them", async () => {
    const acted = jest.fn();
    const t = renderer({ ...NO_VERBS, click: acted });
    const context = checked();
    answered(await contextTurn(t, context));
    answered(await handIn(t.r, click("act", context)));
    const { discovery } = t.rig.cache.configs;
    discovery.follow([context.requested]);
    const config = discovery.snapshotOf(context.requested);
    if (config === null) throw new Error("expected the followed config");
    const configEvent = {
      kind: "config",
      origin: context.requested,
      config,
    } as const;

    const configureCache = t.rig.cache.configure.bind(t.rig.cache);
    t.rig.cache.configure = () => {
      throw new Error("config turn failed");
    };
    const failure = threw(await handIn(t.r, configEvent));
    expect(failure.failure.message).toBe("config turn failed");
    expect(failure.record).toEqual([]);
    expect(t.parts.sessionState.get(SESSION, "click.error")).toContain(
      "config turn failed",
    );
    expect(
      threw(await handIn(t.r, click("act", context))).failure.message,
    ).toBe("config turn failed");
    expect(acted).not.toHaveBeenCalled();

    t.rig.cache.configure = configureCache;
    answered(await handIn(t.r, configEvent));
    expect(viewOf(t.rig)?.facts()).toBe(context);
    expect(acted).not.toHaveBeenCalled();
    answered(await handIn(t.r, click("act", context)));
    expect(acted).toHaveBeenCalledTimes(1);
  });

  test("retirement cancels a parked click and the late config runs no handler", async () => {
    const acted = jest.fn();
    const t = renderer({ ...NO_VERBS, click: acted });
    const context = checked();
    const waiting = answered(await contextTurn(t, context));
    answered(await handIn(t.r, click("act", context)));

    const retired = answered(
      await handIn(t.r, { kind: "retire", session: SESSION }),
    );
    expect(retired.subscriptions.configs).toEqual([]);
    answered(await configsNamed(t, waiting));
    expect(viewOf(t.rig)).toBeNull();
    expect(acted).not.toHaveBeenCalled();
  });

  test("answers with what the open views read once its handler has run", async () => {
    // The handler closes the session's view, so an output read before it ran
    // would still name the view's sources.
    let act = (): void => {};
    const t = renderer({
      ...NO_VERBS,
      click: () => act(),
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
      click: () => act(),
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
      click: (_click, facts) => {
        seen = facts.context;
      },
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
});

describe("the idle close", () => {
  test("closes, in a due turn, the menus of each session idle past its timeout, with no effect", async () => {
    const closed: Array<[string, number]> = [];
    const t = renderer({
      ...NO_VERBS,
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
