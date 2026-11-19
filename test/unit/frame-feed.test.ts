// The host's half of a session's frames (src/daemon/frame-feed.ts): it keeps
// each session's latest request, owns who subscribes on which lane, hands the
// renderer who watches each session, whole and coalesced, and sends each
// subscriber the frames the renderer drew, only where its lane's answer
// changed. When frames are drawn is the renderer's (test/unit/feeds.test.ts).
//
// [LAW:behavior-not-structure] Each case drives the feeds as the daemon does —
// requests noted, subscribers joining and leaving, a turn's frames and lanes
// taken — and reads what subscribers were sent and what the renderer was
// handed.

import { Writable } from "node:stream";
import {
  FrameFeeds,
  type FeedDeps,
  type Subscriber,
} from "../../src/daemon/frame-feed";
import type { Refusal } from "../../src/daemon/foundations/protocol";
import { publishingFrames } from "../../src/daemon/foundations/frame-publication";
import { TEST_SIGNER } from "../helpers/link-signer";
import type { Lane, LaneSwitches } from "../../src/config/lanes";
import type { WireFrame } from "../../src/render/frame";
import { effectsUrl, VERB_COPY } from "../../src/click/wire";
import { actionTarget } from "../../src/render/drawn-link";
import { Feeds } from "../../src/renderer/feeds";
import type { Instant, Tick } from "../../src/utils/instant";
import type {
  EffectId,
  PushedFrame,
  Viewers,
} from "../../src/renderer-interface/interface";
import {
  MAIN_RENDERER,
  rendererNameOf,
} from "../../src/daemon/foundations/renderer-name";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { newestWins } from "../../src/utils/newest-wins";
import type { DisplayedEvent } from "../../src/utils/event-hold";

const S = sessionIdOf("s");
const T = sessionIdOf("t");

// A request as the daemon notes one: the pane it was drawn from, which the
// case says is on a screen or not.
interface Req {
  readonly pane: string;
}

// Feeds over a renderer the case answers: every delivery waits in `owed`
// until the case lets its slot come (`slot`), and reads the viewers then.
function rig(
  publishFrame: FeedDeps<Req>["publishFrame"] = publishingFrames(TEST_SIGNER),
) {
  const hidden = new Set<string>();
  const handed: Viewers[] = [];
  const owed: Array<{
    make: () => Viewers;
    end: (kind: string) => void;
    reject: (thrown: Error) => void;
  }> = [];
  const logged: string[] = [];
  const acknowledged: DisplayedEvent[] = [];
  const watching = { started: 0, stopped: 0 };
  const deps: FeedDeps<Req> = {
    publishFrame,
    acknowledgeDisplayed: (events) => void acknowledged.push(...events),
    requestChanged: () => {},
    shown: (req) => !hidden.has(req.pane),
    watching: () => {
      watching.started++;
      return () => void watching.stopped++;
    },
    deliver: (make) =>
      new Promise((resolve, reject) =>
        owed.push({ make, end: (kind) => resolve({ kind }), reject }),
      ),
    log: (level, line) => void logged.push(`${level} ${line}`),
  };
  const feeds = new FrameFeeds<Req>(deps);
  const settled: [PushedFrame, boolean][] = [];
  const took = (frames: readonly PushedFrame[], renderer = MAIN_RENDERER) =>
    feeds.took(renderer, frames, (pushed, delivered) =>
      settled.push([pushed, delivered]),
    );
  // The next delivery's slot comes: it reads the viewers and the turn ends
  // as `kind`.
  const slot = async (kind = "answered") => {
    const next = owed.shift();
    if (next === undefined) throw new Error("no delivery is owed");
    handed.push(next.make());
    next.end(kind);
    await Promise.resolve();
    await Promise.resolve();
  };
  // A delivery whose host path rejected after its slot read the viewers.
  const rejected = async () => {
    const next = owed.shift()!;
    handed.push(next.make());
    next.reject(new Error("the record broke"));
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    feeds,
    hidden,
    handed,
    owed,
    logged,
    acknowledged,
    watching,
    slot,
    rejected,
    took,
    settled,
  };
}

// A subscriber on `lane`, recording the answers it was sent and its refusal.
type WriterDone = Parameters<Subscriber["frame"]>[1];

function subscriber(
  lane: Lane,
  drawing = true,
  write = (done: WriterDone) => done(true),
) {
  const sent: string[] = [];
  const refusals: Refusal[] = [];
  const sub: Subscriber = {
    lane,
    frame: (json, done) => {
      sent.push(json);
      write(done);
    },
    refused: (resp) => void refusals.push(resp),
    drawing: () => drawing,
  };
  return { sub, sent, refusals };
}

function deferredSubscriber(lane: Lane) {
  const writes: WriterDone[] = [];
  const view = subscriber(lane, true, (done) => writes.push(done));
  return {
    ...view,
    finish(delivered: boolean) {
      const done = writes.shift();
      if (done === undefined) throw new Error("no offered frame to finish");
      done(delivered);
    },
  };
}

const body = (text: string): WireFrame => ({
  depth: "none",
  rows: [{ kind: "diagnostic", runs: [{ text }] }],
  nextChange: null,
  motion: "still",
  pending: [],
});

const ansiAnswer = (text: string) =>
  JSON.stringify({ ok: true, output: `${text}\n` });

const frame = (
  session = S,
  bar = "r",
  handoff: string | null = "s",
  receipt = 1,
  displayedEvents?: readonly DisplayedEvent[],
): PushedFrame => ({
  session,
  frame: {
    kind: "drawn",
    receipt: receipt as EffectId,
    bar: body(bar),
    handoff: handoff === null ? null : body(handoff),
    displayedEvents,
  },
});

// Drive the real host and renderer feeds together, with the viewer mailbox
// slot and each render tick released by the case.
function linkedFeeds() {
  const r = rig();
  const renderer = rendererNameOf("worktree");
  const effect = { verb: VERB_COPY, args: ["captured value"] } as const;
  let receipt = 0;
  const draws = new Feeds({
    draw: () => ({
      frame: {
        kind: "drawn",
        receipt: ++receipt as EffectId,
        bar: {
          ...body("copy"),
          nextChange: Infinity,
          rows: [
            {
              kind: "diagnostic",
              runs: [{ text: "copy", link: actionTarget([effect]) }],
            },
          ],
        },
        handoff: null,
      },
      evaluated: 1,
      cellBreaks: 0,
      failure: null,
    }),
    pin: () => () => {},
    log: () => {},
    periods: { moving: 100, still: 1000 },
  });
  return {
    ...r,
    signed: TEST_SIGNER.signLink(effectsUrl([effect]), {
      renderer,
      session: S,
    }),
    async deliver(tick: number) {
      await r.slot();
      draws.view(r.handed.at(-1)!, tick as Tick);
    },
    due(tick: number) {
      const frames: PushedFrame[] = [];
      draws.drawDue(
        { at: (1000 + tick) as Instant, tick: tick as Tick },
        frames,
        () => {
          throw new Error("the feed fixture builds its own receipt");
        },
      );
      r.took(frames, renderer);
      return frames;
    },
  };
}

describe("a session's requests", () => {
  test("the latest is the one received last, however late an earlier one's render finishes", () => {
    const { feeds } = rig();
    feeds.note(S, { pane: "%2" }, 2);
    feeds.note(S, { pane: "%1" }, 1);
    expect(feeds.latest(S)).toEqual({ pane: "%2" });
    expect(feeds.latest(T)).toBeNull();
  });

  test("newestWhere finds the session of the newest request it matches, and counts its lookups", () => {
    const { feeds } = rig();
    feeds.note(S, { pane: "%1" }, 1);
    feeds.note(T, { pane: "%1" }, 2);
    expect(feeds.newestWhere((req) => req.pane === "%1")).toBe(T);
    expect(feeds.newestWhere((req) => req.pane === "%9")).toBeNull();
    expect(feeds.getStats()).toMatchObject({ lookups: 2, found: 1 });
  });

  test("a watched session's request outlives the eviction of the least recently noted", () => {
    const { feeds } = rig();
    feeds.note(S, { pane: "%0" }, 0);
    feeds.subscribe(S, subscriber("pane").sub);
    for (let i = 1; i <= 300; i++)
      feeds.note(sessionIdOf(`other${i}`), { pane: `%${i}` }, i);
    expect(feeds.latest(S)).toEqual({ pane: "%0" });
    expect(feeds.latest(sessionIdOf("other1"))).toBeNull();
    expect(feeds.watchedRequests()).toEqual([{ pane: "%0" }]);
  });
});

describe("the viewers the renderer is handed", () => {
  test("name each watched session's lanes, their subscribers and whether any draws, and whether its pane is on a screen", async () => {
    const r = rig();
    r.feeds.note(S, { pane: "%1" }, 1);
    r.hidden.add("%1");
    r.feeds.subscribe(S, subscriber("pane", false).sub);
    r.feeds.subscribe(S, subscriber("pane", true).sub);
    r.feeds.subscribe(T, subscriber("statusline", false).sub);
    expect(r.feeds.viewers()).toEqual({
      [S]: {
        lanes: { pane: { subscribers: 2, drawing: true } },
        shown: false,
        joined: 2,
      },
      // A session with no request yet counts as shown.
      [T]: {
        lanes: { statusline: { subscribers: 1, drawing: false } },
        shown: true,
        joined: 3,
      },
    });
  });

  test("announcements before the delivery's slot comes are one delivery, read as its slot comes", async () => {
    const r = rig();
    r.feeds.subscribe(S, subscriber("pane").sub);
    r.feeds.subscribe(T, subscriber("pane").sub);
    expect(r.owed).toHaveLength(1);
    await r.slot();
    expect(Object.keys(r.handed[0]!)).toEqual([S, T]);
  });

  test("viewers that read as last handed are not handed again; a start's handing counts", async () => {
    const r = rig();
    const { sub } = subscriber("pane");
    r.feeds.subscribe(S, sub);
    await r.slot();
    r.feeds.announce();
    expect(r.owed).toHaveLength(0);
    // A renderer's start was handed these viewers: the one owed now is not.
    r.feeds.handedIn({});
    r.feeds.announce();
    expect(r.owed).toHaveLength(1);
  });

  test("a delivery that failed is made good by the next announcement, though the viewers did not change", async () => {
    const r = rig();
    r.feeds.subscribe(S, subscriber("pane").sub);
    await r.slot("threw");
    r.feeds.announce();
    expect(r.owed).toHaveLength(1);
    await r.slot();
    expect(r.handed).toHaveLength(2);
  });

  test("a delivery that rejected is said, and the next announcement delivers again", async () => {
    const r = rig();
    r.feeds.subscribe(S, subscriber("pane").sub);
    await r.rejected();
    expect(r.logged).toContainEqual(
      expect.stringMatching(
        /^error feed viewers delivery rejected: .*the record broke/,
      ),
    );
    r.feeds.announce();
    expect(r.owed).toHaveLength(1);
    await r.slot();
    expect(r.handed).toHaveLength(2);
  });

  test("a request whose pane comes off a screen is announced; one that changes nothing the renderer is handed is not", async () => {
    const r = rig();
    r.feeds.note(S, { pane: "%1" }, 1);
    r.feeds.subscribe(S, subscriber("pane").sub);
    await r.slot();
    r.feeds.note(S, { pane: "%1" }, 2);
    expect(r.owed).toHaveLength(0);
    r.hidden.add("%2");
    r.feeds.note(S, { pane: "%2" }, 3);
    expect(r.owed).toHaveLength(1);
    await r.slot();
    expect(r.handed.at(-1)![S]!.shown).toBe(false);
  });
});

describe("a subscriber", () => {
  test("is sent each frame whose answer for its lane changed, and nothing for one that changed only another lane's", () => {
    const r = rig();
    const pane = subscriber("pane");
    const line = subscriber("statusline");
    r.feeds.subscribe(S, pane.sub);
    r.feeds.subscribe(S, line.sub);
    r.took([frame(S, "r1", "s1")]);
    r.took([frame(S, "r2", "s1")]);
    expect(pane.sent).toEqual([ansiAnswer("r1"), ansiAnswer("r2")]);
    expect(line.sent).toEqual([ansiAnswer("s1")]);
    expect(r.feeds.getStats()).toMatchObject({
      feeds: 1,
      subscribers: 2,
      pushed: 3,
    });
  });

  test("both lanes receive identical terminal bytes without a handoff and repeat frames are deduplicated", () => {
    const { feeds, took } = rig();
    const pane = subscriber("pane");
    const statusline = subscriber("statusline");
    feeds.subscribe(S, pane.sub);
    feeds.subscribe(S, statusline.sub);
    const bar = body("answer");
    took([
      {
        session: S,
        frame: { kind: "drawn", receipt: 1 as EffectId, bar, handoff: null },
      },
    ]);
    took([
      {
        session: S,
        frame: {
          kind: "drawn",
          receipt: 2 as EffectId,
          bar: { ...bar, nextChange: 45 },
          handoff: null,
        },
      },
    ]);
    expect(pane.sent).toEqual([ansiAnswer("answer")]);
    expect(statusline.sent).toEqual(pane.sent);
  });

  test("a failed draw uses the same refusal bytes in both lanes", () => {
    const { feeds, took, settled } = rig();
    const pane = subscriber("pane");
    const statusline = subscriber("statusline");
    feeds.subscribe(S, pane.sub);
    feeds.subscribe(S, statusline.sub);
    const failure: PushedFrame = {
      session: S,
      frame: { kind: "failed", message: "draw broke" },
    };
    took([failure, failure]);
    expect(pane.sent).toHaveLength(1);
    expect(statusline.sent).toEqual(pane.sent);
    expect(JSON.parse(pane.sent[0]!)).toMatchObject({
      ok: false,
      code: "RENDER_FAILED",
      error: "draw broke",
    });
    expect(settled).toEqual([
      [failure, false],
      [failure, false],
    ]);
  });

  test("joining later is handed the bar as it stands, at once", () => {
    const r = rig();
    r.feeds.subscribe(S, subscriber("pane").sub);
    r.took([frame(S, "r1", "s1")]);
    const late = subscriber("pane");
    r.feeds.subscribe(S, late.sub);
    expect(late.sent).toEqual([ansiAnswer("r1")]);
  });

  test("of a session unwatched since the renderer drew it is sent nothing", () => {
    const r = rig();
    const { sub, sent } = subscriber("pane");
    const leave = r.feeds.subscribe(S, sub);
    leave();
    const pushed = frame(S);
    r.took([pushed]);
    expect(sent).toEqual([]);
    expect(r.feeds.isWatched(S)).toBe(false);
    expect(r.settled).toEqual([[pushed, false]]);
  });

  test("the feeds watch from the first subscriber to the last leaving, which is logged with what it was sent", () => {
    const r = rig();
    const leaveS = r.feeds.subscribe(S, subscriber("pane").sub);
    const leaveT = r.feeds.subscribe(T, subscriber("pane").sub);
    expect(r.watching).toEqual({ started: 1, stopped: 0 });
    r.took([frame(S)]);
    leaveS();
    expect(r.watching.stopped).toBe(0);
    leaveT();
    expect(r.watching).toEqual({ started: 1, stopped: 1 });
    expect(r.logged).toContain(`info feed sid="${S}" unwatched pushed=1`);
  });
});

describe("feed delivery", () => {
  test("a hot viewer replacement receives the same signed bytes without another draw", async () => {
    const r = linkedFeeds();
    const old = subscriber("pane");
    const leave = r.feeds.subscribe(S, old.sub);
    const staying = subscriber("statusline");
    r.feeds.subscribe(S, staying.sub);
    await r.deliver(0);
    const [first] = r.due(0);
    expect(old.sent).toHaveLength(1);
    expect(old.sent[0]).toContain(r.signed);
    expect(r.settled).toEqual([[first, true]]);

    leave();
    const replacement = deferredSubscriber("pane");
    r.feeds.subscribe(S, replacement.sub);
    expect(replacement.sent).toEqual(old.sent);
    replacement.finish(true);
    await r.deliver(0.1);
    expect(r.due(0.1)).toEqual([]);
    expect(staying.sent).toEqual(old.sent);
    expect(r.settled).toEqual([[first, true]]);
    expect(r.feeds.getStats()).toMatchObject({
      feeds: 1,
      subscribers: 2,
      pushed: 3,
    });
  });

  test("a sole viewer comes back to a new draw when the host has released its cached frame", async () => {
    const r = linkedFeeds();
    const old = subscriber("pane");
    const leave = r.feeds.subscribe(S, old.sub);
    await r.deliver(0);
    const [first] = r.due(0);
    expect(old.sent).toHaveLength(1);

    leave();
    expect(r.feeds.isWatched(S)).toBe(false);
    const replacement = deferredSubscriber("pane");
    r.feeds.subscribe(S, replacement.sub);
    expect(replacement.sent).toEqual([]);
    // The renderer's single slot sees the old count again and needs a first
    // frame despite never seeing an empty membership.
    await r.deliver(0.1);
    const [fresh] = r.due(0.1);
    expect(fresh).toBeDefined();
    expect(replacement.sent).toEqual(old.sent);
    expect(r.settled).toEqual([[first, true]]);
    replacement.finish(true);
    expect(r.settled).toEqual([
      [first, true],
      [fresh, true],
    ]);
  });

  test("a declined handover asks for a frame after an unchanged viewer delivery", async () => {
    const r = linkedFeeds();
    const leave = r.feeds.subscribe(S, subscriber("pane").sub);
    r.feeds.subscribe(S, subscriber("statusline").sub);
    await r.deliver(0);
    const [first] = r.due(0);

    leave();
    const replacement = deferredSubscriber("pane");
    r.feeds.subscribe(S, replacement.sub);
    await r.deliver(0.1);
    expect(r.due(0.1)).toEqual([]);
    replacement.finish(false);
    await r.deliver(0.2);
    const [fresh] = r.due(0.2);
    expect(fresh).toBeDefined();
    expect(replacement.sent).toHaveLength(2);
    expect(replacement.sent[0]).toBe(replacement.sent[1]);
    replacement.finish(true);
    expect(r.settled).toEqual([
      [first, true],
      [fresh, true],
    ]);
  });

  test("visibility and count changes wake a feed while a pending handover shares its next write", async () => {
    const r = linkedFeeds();
    r.hidden.add("%1");
    r.feeds.note(S, { pane: "%1" }, 1);
    const old = subscriber("pane");
    const leave = r.feeds.subscribe(S, old.sub);
    r.feeds.subscribe(S, subscriber("statusline").sub);
    await r.deliver(0);
    const [first] = r.due(0);

    leave();
    const replacement = deferredSubscriber("pane");
    r.feeds.subscribe(S, replacement.sub);
    r.hidden.delete("%1");
    r.feeds.announce();
    await r.deliver(0.1);
    const [shown] = r.due(0.1);
    expect(shown).toBeDefined();
    expect(replacement.sent).toEqual(old.sent);
    replacement.finish(true);
    expect(r.owed).toHaveLength(0);
    expect(r.settled).toEqual([
      [first, true],
      [shown, true],
    ]);

    r.feeds.subscribe(S, subscriber("pane").sub);
    await r.deliver(0.2);
    expect(r.due(0.2)).toHaveLength(1);
  });

  test("the confirmed bytes are published for the renderer and session that drew them", () => {
    const publish = publishingFrames(TEST_SIGNER);
    const routes: Parameters<FeedDeps<Req>["publishFrame"]>[1][] = [];
    const { feeds, took, settled } = rig((bar, source) => {
      routes.push(source);
      return publish(bar, source);
    });
    const worktree = rendererNameOf("worktree");
    const pane = deferredSubscriber("pane");
    feeds.subscribe(S, pane.sub);
    const pushed = frame(S, "alternate", null);
    took([pushed], worktree);
    expect(routes).toEqual([{ renderer: worktree, session: S }]);
    expect(settled).toEqual([]);
    pane.finish(true);
    expect(settled).toEqual([[pushed, true]]);
  });

  test("one fast subscriber settles the candidate without waiting for a slower one", () => {
    const { feeds, took, settled } = rig();
    const pane = deferredSubscriber("pane");
    const statusline = subscriber("statusline");
    feeds.subscribe(S, pane.sub);
    feeds.subscribe(S, statusline.sub);
    const pushed = frame();

    took([pushed]);
    expect(pane.sent).toEqual([ansiAnswer("r")]);
    expect(statusline.sent).toEqual([ansiAnswer("s")]);
    expect(settled).toEqual([[pushed, true]]);
    pane.finish(false);
    expect(settled).toEqual([[pushed, true]]);
  });

  test("transport backpressure declines the replaced draw and confirms only the bytes written", () => {
    const { feeds, took, settled } = rig();
    const written: string[] = [];
    const completions: (() => void)[] = [];
    const out = new Writable({
      highWaterMark: 1,
      write(bytes: Buffer, _encoding, complete) {
        written.push(bytes.toString());
        completions.push(complete);
      },
    });
    feeds.subscribe(S, { ...subscriber("pane").sub, frame: newestWins(out) });
    const first = frame(S, "first", null, 1);
    const second = frame(S, "second", null, 2);
    const third = frame(S, "third", null, 3);

    took([first, second, third]);
    expect(written).toEqual([ansiAnswer("first")]);
    expect(settled).toEqual([[second, false]]);
    completions.shift()!();
    expect(settled).toEqual([
      [second, false],
      [first, true],
    ]);
    completions.shift()!();
    expect(written).toEqual([ansiAnswer("first"), ansiAnswer("third")]);
    expect(settled).toEqual([
      [second, false],
      [first, true],
      [third, true],
    ]);
  });

  test("the newest identical candidate waits for the offered write and later matches are already presented", () => {
    const { feeds, took, settled } = rig();
    const pane = deferredSubscriber("pane");
    feeds.subscribe(S, pane.sub);
    const first = frame(S, "same", null, 1);
    const second = frame(S, "same", null, 2);
    const third = frame(S, "same", null, 3);
    const fourth = frame(S, "same", null, 4);

    took([first]);
    expect(settled).toEqual([]);
    took([second, third]);
    expect(pane.sent).toEqual([ansiAnswer("same")]);
    expect(settled).toEqual([
      [first, false],
      [second, false],
    ]);
    pane.finish(true);
    took([fourth]);
    expect(pane.sent).toEqual([ansiAnswer("same")]);
    expect(settled).toEqual([
      [first, false],
      [second, false],
      [third, true],
      [fourth, true],
    ]);
  });

  test("an identical candidate is retried after a failed write", () => {
    const { feeds, took, settled } = rig();
    const pane = deferredSubscriber("pane");
    feeds.subscribe(S, pane.sub);
    const first = frame(S, "retry", null, 1);
    const second = frame(S, "retry", null, 2);
    took([first]);
    pane.finish(false);
    took([second]);
    expect(pane.sent).toEqual([ansiAnswer("retry"), ansiAnswer("retry")]);
    expect(settled).toEqual([[first, false]]);
    pane.finish(true);
    expect(settled).toEqual([
      [first, false],
      [second, true],
    ]);
  });

  test("a return to confirmed bytes still writes behind a different outstanding frame", () => {
    const { feeds, took, settled } = rig();
    const pane = deferredSubscriber("pane");
    feeds.subscribe(S, pane.sub);
    const initial = frame(S, "initial", null, 1);
    const different = frame(S, "changed", null, 2);
    const returned = frame(S, "initial", null, 3);
    took([initial]);
    pane.finish(true);
    took([different, returned]);
    expect(pane.sent).toEqual([
      ansiAnswer("initial"),
      ansiAnswer("changed"),
      ansiAnswer("initial"),
    ]);
    expect(settled).toEqual([[initial, true]]);
    pane.finish(true);
    pane.finish(true);
    expect(settled).toEqual([
      [initial, true],
      [different, true],
      [returned, true],
    ]);
  });

  test("unsubscribe and close settle only when all outstanding subscribers decline", () => {
    const { feeds, took, settled } = rig();
    const pane = deferredSubscriber("pane");
    const statusline = deferredSubscriber("statusline");
    const leave = feeds.subscribe(S, pane.sub);
    feeds.subscribe(S, statusline.sub);
    const pushed = frame();
    took([pushed]);

    leave();
    pane.finish(true);
    expect(settled).toEqual([]);
    feeds.close();
    statusline.finish(true);
    expect(settled).toEqual([[pushed, false]]);
  });

  test("a subscriber that throws cannot block another subscriber's delivery", () => {
    const { feeds, took, settled, logged } = rig();
    const pane = subscriber("pane", true, () => {
      throw new Error("broken subscriber");
    });
    const statusline = subscriber("statusline");
    feeds.subscribe(S, pane.sub);
    feeds.subscribe(S, statusline.sub);
    const pushed = frame();

    took([pushed]);
    expect(statusline.sent).toEqual([ansiAnswer("s")]);
    expect(settled).toEqual([[pushed, true]]);
    expect(logged).toContainEqual(
      expect.stringContaining("send failed: Error: broken subscriber"),
    );
  });

  test("encoding failure sends refusal bytes and declines the draw while the next session still presents", () => {
    const publish = publishingFrames(TEST_SIGNER);
    let encodingFirst = true;
    const { feeds, took, settled, logged } = rig((body) => {
      if (encodingFirst) {
        encodingFirst = false;
        throw new Error("encoding broke");
      }
      return publish(body);
    });
    const first = subscriber("pane");
    const second = subscriber("pane");
    feeds.subscribe(S, first.sub);
    feeds.subscribe(T, second.sub);
    const failed = frame(S, "bad", null);
    const drawn = frame(T, "good", null);

    took([failed, drawn]);
    expect(JSON.parse(first.sent[0]!)).toMatchObject({
      ok: false,
      code: "RENDER_FAILED",
    });
    expect(second.sent).toEqual([ansiAnswer("good")]);
    expect(settled).toEqual([
      [failed, false],
      [drawn, true],
    ]);
    expect(logged).toContainEqual(expect.stringContaining("encoding broke"));
  });
});

describe("a subscription's lane", () => {
  const OFF: LaneSwitches = {
    statusline: true,
    pane: false,
  };

  test("switched off in the session's settings is refused at once, and opens nothing", () => {
    const r = rig();
    r.feeds.switched({ [S]: OFF });
    const { sub, refusals } = subscriber("pane");
    r.feeds.subscribe(S, sub);
    expect(refusals).toEqual([
      expect.objectContaining({ ok: false, code: "SWITCHED_OFF" }),
    ]);
    expect(r.feeds.isWatched(S)).toBe(false);
    expect(r.owed).toHaveLength(0);
    expect(r.feeds.getStats().refused).toBe(1);
  });

  test("of a session with no view yet is admitted, and the switches its view opens with decide", () => {
    const r = rig();
    const pane = subscriber("pane");
    const line = subscriber("statusline");
    r.feeds.subscribe(S, pane.sub);
    r.feeds.subscribe(S, line.sub);
    r.feeds.switched({ [S]: OFF });
    expect(pane.refusals).toHaveLength(1);
    expect(line.refusals).toHaveLength(0);
    // The other lane streams on.
    r.took([frame(S)]);
    expect(pane.sent).toEqual([]);
    expect(line.sent).toEqual([ansiAnswer("s")]);
  });
});

describe("the daemon's close", () => {
  test("ends every subscriber, hands the renderer nothing more, and drops a subscribe after it, saying so", async () => {
    const r = rig();
    r.feeds.subscribe(S, subscriber("pane").sub);
    await r.slot();
    r.feeds.close();
    expect(r.feeds.isWatched(S)).toBe(false);
    expect(r.watching.stopped).toBe(1);
    expect(r.owed).toHaveLength(0);
    r.feeds.subscribe(T, subscriber("pane").sub);
    expect(r.feeds.isWatched(T)).toBe(false);
    expect(r.logged.at(-1)).toBe(
      `info feed sid="${T}" dropped lane=pane daemon-closed`,
    );
  });
});

test("equal pane bytes with a different event require a new confirmed write", () => {
  const { feeds, took, settled, acknowledged } = rig();
  const pane = deferredSubscriber("pane");
  feeds.subscribe(S, pane.sub);
  const event = { text: "an act failed", at: 7 as Instant, answered: false };
  const first: DisplayedEvent = {
    kind: "act-failed",
    event: { ...event, revision: 1 },
  };
  const second: DisplayedEvent = {
    kind: "act-failed",
    event: { ...event, revision: 2 },
  };
  const older = frame(S, "warning", null, 1, [first]);
  const newer = frame(S, "warning", null, 2, [second]);
  const retry = frame(S, "warning", null, 3, [second]);
  took([older, newer]);
  expect(pane.sent).toEqual([ansiAnswer("warning"), ansiAnswer("warning")]);
  expect(settled).toEqual([]);
  pane.finish(true);
  pane.finish(false);
  expect(acknowledged).toEqual([first]);
  expect(settled).toEqual([
    [older, true],
    [newer, false],
  ]);

  took([retry]);
  expect(acknowledged).toEqual([first]);
  pane.finish(true);
  expect(acknowledged).toEqual([first, second]);

  const unchanged = frame(S, "warning", null, 4, [
    { ...second, event: { ...second.event, answered: true } },
  ]);
  took([unchanged]);
  expect(pane.sent).toHaveLength(3);
  expect(settled.at(-1)).toEqual([unchanged, true]);
  expect(acknowledged).toEqual([first, second]);
});

test("a hot pane replay can acknowledge the event in its cached frame", () => {
  const { feeds, took, settled, acknowledged } = rig();
  const initial = deferredSubscriber("pane");
  feeds.subscribe(S, initial.sub);
  const shown: DisplayedEvent = {
    kind: "renderer-ended",
    event: { text: "the renderer ended", at: 7 as Instant, answered: false },
  };
  const offered = frame(S, "warning", null, 1, [shown]);
  took([offered]);
  initial.finish(false);
  expect(acknowledged).toEqual([]);

  const fresh = deferredSubscriber("pane");
  feeds.subscribe(S, fresh.sub);
  expect(fresh.sent).toEqual(initial.sent);
  expect(acknowledged).toEqual([]);
  fresh.finish(true);
  expect(acknowledged).toEqual([shown]);
  expect(settled).toEqual([[offered, false]]);
});

test("a slower pane confirmation reports its own event after another pane confirmed a later one", () => {
  const { feeds, took, settled, acknowledged } = rig();
  const slower = deferredSubscriber("pane");
  const faster = deferredSubscriber("pane");
  feeds.subscribe(S, slower.sub);
  feeds.subscribe(S, faster.sub);
  const event = {
    text: "the renderer ended",
    at: 7 as Instant,
    answered: false,
  };
  const first: DisplayedEvent = {
    kind: "renderer-ended",
    event: { ...event, revision: 1 },
  };
  const second: DisplayedEvent = {
    kind: "renderer-ended",
    event: { ...event, revision: 2 },
  };
  const older = frame(S, "old", null, 1, [first]);
  const newer = frame(S, "new", null, 2, [second]);
  took([older, newer]);
  faster.finish(false);
  faster.finish(true);
  expect(settled).toEqual([[newer, true]]);
  expect(acknowledged).toEqual([second]);
  slower.finish(true);
  expect(settled).toEqual([
    [newer, true],
    [older, true],
  ]);
  expect(acknowledged).toEqual([second, first]);
});
