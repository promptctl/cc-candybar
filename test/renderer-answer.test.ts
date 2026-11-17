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
} from "../src/renderer-interface/interface";
import { mainRenderer, type RendererClocks } from "../src/renderer/main";
import { timed } from "../src/renderer-interface/wire";
import { renderFrame, type RendererParts } from "../src/renderer/draw-bar";
import { MOVING_FPS, UNFOLLOWED_FEEDS } from "../src/config/lanes";
import {
  NO_VERBS,
  rendererClocks,
  rendererParts,
} from "./helpers/renderer-parts";
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
  unframed,
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
// every line the daemon's log was handed, each pipe event an answer told the
// host it carried, and the clocks its turns keep. `daemon` is what every world
// state carries of the daemon itself.
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
  readonly clocks: RendererClocks;
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
    log: (level, message) => logged.push(`${level} ${message}`),
  };
  // The cache's record of a delivered frame, heard on its way in.
  const recorded: string[][] = [];
  const record = rig.cache.delivered.bind(rig.cache);
  rig.cache.delivered = (sessionId, by, copies) => {
    recorded.push([...copies.values()]);
    record(sessionId, by, copies);
  };
  const clocks = rendererClocks();
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
    // The turn's record is the draw's half of the render event.
    expect(new Map(record).get("handoff")).toBe("-");
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
        sessions: [mine, theirs].map((context) => ({
          context,
          worldState: rig.served.collector.requested(context),
        })),
        viewers: {},
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
    const frame = renderFrame(parts, SESSION, MOVING_FPS, AT, {
      following: new Set(),
      feeds: UNFOLLOWED_FEEDS,
      idleSince: null,
    });
    expect(frame?.frame.failure).toBeNull();
    expect(recorded).toEqual([[expect.stringMatching(/--bogus/)]]);
    expect(by).toEqual(["feed"]);
  });

  // A wake while a frame is out is owed a frame after it, so a draw that woke
  // its own feed would keep a still bar drawing at the moving rate.
  test("moves nothing its feed wakes for: neither the view's data nor the session's state", async () => {
    const { r, parts, changed, rig } = renderer();
    answered(await request({ r, rig }));
    const draw = (at: Instant) =>
      renderFrame(parts, SESSION, MOVING_FPS, at, {
        following: new Set(),
        feeds: UNFOLLOWED_FEEDS,
        idleSince: null,
      });
    const changedBefore = changed.length;
    const revision = rig.sessionState.latestRevision();
    expect(draw(AT)?.frame.failure).toBeNull();
    expect(draw((AT + 1) as Instant)?.frame.failure).toBeNull();
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
    expect(subscriptions.tmuxStatus).not.toContain(other);
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
      hearingEvents(timed(t.r, systemTimekeeper), (input) =>
        kinds.push(input.event.kind),
      ),
      () => {},
      unframed(t.rig.served.collector),
      NO_ACTS,
    );
    const facts: Array<readonly [string, string]> = [];
    const answered = await answerStatusline(
      host,
      t.rig.served.collector,
      systemTimekeeper,
      new AbortController().signal,
      () => {},
      checked(),
      REQUEST,
      AT,
      (instantAt(systemTimekeeper) + 5) as Instant,
      facts as never,
    );
    expect(kinds).toEqual(["config"]);
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
      hearingEvents(timed(t.r, systemTimekeeper), (input) => {
        if (input.event.kind === "config")
          requests.push(input.event.worldState);
      }),
      () => {},
      unframed(t.rig.served.collector),
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
        AT,
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

describe("the idle close", () => {
  // [LAW:no-ambient-temporal-coupling] The renderer reads no clock: the
  // close falls in the due turn the host hands in at the instant the renderer
  // declared, and a turn before it closes nothing.
  test("closes the session's menus in the due turn at its deadline, with no effect, and declares its instant until then", async () => {
    const closed: string[] = [];
    const t = renderer({
      ...NO_VERBS,
      handler: () => undefined,
      closeIdle: (_latest, idle) => {
        closed.push(`${idle.session} ${idle.idleS}/${idle.timeoutS}`);
      },
    });
    t.clocks.menuIdle.drew(SESSION, AT, { shown: true, timeoutS: 30 });
    const dueAt = (at: number) =>
      t.r.answer({ kind: "event", at: at as Instant, event: { kind: "due" } });
    const early = answered(await dueAt(AT + 29));
    expect(closed).toEqual([]);
    expect(early.subscriptions.wake).toBe(AT + 30);
    const { effects, subscriptions } = answered(await dueAt(AT + 30));
    expect(effects).toEqual([]);
    expect(closed).toEqual([`${SESSION} 30/30`]);
    expect(subscriptions.wake).toBeNull();
  });

  test("that throws is said against its session, and the due turn still answers", async () => {
    const t = renderer({
      ...NO_VERBS,
      handler: () => undefined,
      closeIdle: () => {
        throw new Error("the menu would not shut");
      },
    });
    t.clocks.menuIdle.drew(SESSION, AT, { shown: true, timeoutS: 30 });
    const { subscriptions } = answered(
      await t.r.answer({
        kind: "event",
        at: (AT + 30) as Instant,
        event: { kind: "due" },
      }),
    );
    expect(t.logged).toContainEqual(
      expect.stringMatching(
        new RegExp(`^error menu-idle: close failed \\(session=${SESSION}\\): .*would not shut`),
      ),
    );
    // Shut as it was handed out: it falls due again only once a frame draws a
    // menu again.
    expect(subscriptions.wake).toBeNull();
  });
});
