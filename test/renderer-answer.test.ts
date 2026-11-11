// The main renderer answers a statusline request through `answer` alone
// (src/renderer/interface.ts): the request's turn returns one `present` for
// the statusline, carrying the request it answers and the frame drawn, and the
// present's `effect-done` is what records what the frame showed. A world state
// the host hands in is what its session's view draws from, a retire closes the
// view, and every output says what the open views need read.
//
// [LAW:behavior-not-structure] The renderer is built over the daemon's own
// view composition (test/helpers/session-rig.ts) and narrow fakes for the host
// parts its side still reaches; no daemon is built.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UNFOLLOWED_FEEDS } from "../src/config/lanes";
import type { RendererParts } from "../src/daemon/draw-bar";
import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import { checkRenderRequest } from "../src/daemon/render-checkpoint";
import { RenderWarningRecords } from "../src/daemon/render-warnings";
import { EffectSessions } from "../src/render/effect";
import {
  TurnThrew,
  type Effect,
  type EffectId,
  type Renderer,
  type Event,
  type RequestId,
} from "../src/renderer/interface";
import { mainRenderer } from "../src/renderer/main";
import type { CheckedRenderRequest } from "../src/renderer/request-context";
import { systemTimekeeper } from "../src/time";
import { TEST_SIGNER } from "./helpers/link-signer";
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
import { answerStatusline } from "../src/daemon/statusline-answer";
import type { WorldState } from "../src/facts/world-state";
import type { SessionId } from "../src/daemon/session-id";

let dir: string;
let cleanups: Array<() => void>;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-answer-")));
  cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
});

const NO_STATS = { size: 0, hits: 0, misses: 0 };

// The renderer over the rig's render cache and owners, and the copies each
// delivered frame recorded in that cache, in the order they were recorded.
function renderer(): {
  readonly r: Renderer;
  readonly recorded: string[][];
  readonly rig: SessionRig;
} {
  const rig = sessionRig(dir, cleanups);
  const { providers } = rig;
  const parts: RendererParts = {
    clock: systemTimekeeper,
    log: () => {},
    sessionState: rig.sessionState,
    renderCache: rig.cache as never,
    worldStates: rig.served.worldStates,
    payloadProviders: {
      ...providers,
      gitProvider: { ...providers.gitProvider, getStats: () => NO_STATS },
      usageStore: { ...providers.usageStore, getStats: () => NO_STATS },
    } as never,
    linkSigner: TEST_SIGNER,
    renderWarnings: new RenderWarningRecords(),
    effectSessions: new EffectSessions(),
    frameFeeds: { feedsOf: () => UNFOLLOWED_FEEDS, following: () => new Set() },
    updateWatch: { notice: () => ({ offer: [], failure: [] }), error: () => null },
    fileEvents: {
      delivery: () => ({ kind: "delivering", unreported: [], missedSince: null }),
    },
    menuIdle: { observe: () => {}, since: () => undefined },
    launcher: { launcherWarnings: () => [], answeredPipeEvent: () => {} },
    laneSetups: { noted: () => {} },
    tmuxStatusLines: { observe: () => {} },
  };
  // The cache's record of a delivered frame, heard on its way in.
  const recorded: string[][] = [];
  const record = rig.cache.delivered.bind(rig.cache);
  rig.cache.delivered = (sessionId, by, copies) => {
    recorded.push([...copies.values()]);
    record(sessionId, by, copies);
  };
  return { r: mainRenderer(parts), recorded, rig };
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

// The request as the host delivers one: with the world state its collector
// read at the request's keys.
const request = ({ r, rig }: { r: Renderer; rig: SessionRig }) => {
  const context = checked();
  return r.answer({
    kind: "event",
    at: AT,
    event: {
      kind: "request",
      id: REQUEST,
      context,
      worldState: rig.served.collector.requested(context),
      waitEndsAt: systemTimekeeper.monotonic() + 5_000,
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

const done = (r: Renderer, of: EffectId, ok: boolean) =>
  r.answer({
    kind: "event",
    at: AT,
    event: {
      kind: "effect-done",
      of,
      outcome: ok ? { kind: "ok" } : { kind: "failed", reason: "left" },
    },
  });

const presentOf = (effects: readonly Effect[]): Effect => {
  expect(effects).toHaveLength(1);
  return effects[0]!;
};

describe("a statusline request", () => {
  test("is answered by one present for the statusline, carrying its request and the drawn bar", async () => {
    const { effects, record } = await request(renderer());
    const present = presentOf(effects);
    expect(present).toMatchObject({
      kind: "present",
      surface: "statusline",
      session: SESSION,
      request: REQUEST,
    });
    expect(present.frame.rows.length).toBeGreaterThan(0);
    // The turn's record is the render event's renderer half.
    expect(new Map(record).get("sid")).toBe(SESSION);
    expect(new Map(record).has("drew")).toBe(true);
  });

  test("records what its frame showed only once the present's effect-done says it arrived", async () => {
    const { r, recorded, rig } = renderer();
    const { effects } = await request({ r, rig });
    expect(recorded).toEqual([]);
    await done(r, presentOf(effects).id, true);
    expect(recorded).toEqual([[expect.stringMatching(/--bogus/)]]);
  });

  test("records nothing for a present its client never took, and hears of each present once", async () => {
    const { r, recorded, rig } = renderer();
    const { id } = presentOf((await request({ r, rig })).effects);
    await done(r, id, false);
    expect(recorded).toEqual([]);
    await expect(done(r, id, true)).rejects.toThrow(TurnThrew);
    await expect(done(r, id, true)).rejects.toThrow(
      /not a present on its way/,
    );
  });
});

describe("the world state the host hands in", () => {
  test("is what the session's view draws from, and an older seq is refused", async () => {
    const t = renderer();
    await request(t);
    const held = t.rig.served.worldStates.of(SESSION as SessionId);
    const next = {
      ...held,
      seq: held.seq + 1,
      builtins: { ...held.builtins, hostName: { ...ok("elsewhere"), at: AT } },
    };
    const { effects } = await handIn(t.r, {
      kind: "world-state",
      worldState: next,
    });
    expect(effects).toEqual([]);
    expect(viewOf(t.rig)?.source.facts()).toBe(next);
    await expect(
      handIn(t.r, { kind: "world-state", worldState: held }),
    ).rejects.toThrow(/does not follow the held seq/);
  });

  test("a retire closes the session's view and drops its world state", async () => {
    const t = renderer();
    await request(t);
    expect(viewOf(t.rig)).not.toBeNull();
    const { subscriptions } = await handIn(t.r, {
      kind: "retire",
      session: SESSION as SessionId,
    });
    expect(viewOf(t.rig)).toBeNull();
    expect(subscriptions.sources).toEqual({});
    expect(() => t.rig.served.worldStates.of(SESSION as SessionId)).toThrow(
      /no world state for session/,
    );
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
      {
        answer: (input) => {
          if (input.event.kind === "request")
            requests.push(input.event.worldState);
          return t.r.answer(input);
        },
      },
      () => {},
      (subscriptions) => t.rig.served.collector.subscribed(subscriptions),
    );
    const ask = (pane: string, id: number) =>
      answerStatusline(
        host,
        t.rig.served.collector,
        systemTimekeeper,
        checked(pane),
        id as RequestId,
        AT,
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
