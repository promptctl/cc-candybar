import { DeclaredSurfaces } from "../../src/daemon/declared-bar-panes";
import type { BarPaneEdge, ManagedPane } from "../../src/daemon/lane-setup";
import type { PaneHello, PaneStream } from "../../src/daemon/pane-subscription";
import { FrameFeeds } from "../../src/daemon/frame-feed";
import type { Viewers } from "../../src/renderer-interface/interface";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { heldClock } from "../helpers/held-clock";

const source = { pane: "%1", socket: "/fixture/tmux", truecolor: null };
const a = sessionIdOf("first"),
  b = sessionIdOf("second");
const enabled = { pane: true, statusline: false, window: false };
const off = { ...enabled, pane: false };
const host = {
  node: ["/test/node"],
  bundle: "/test/bundle",
  socket: "/test/daemon",
};
const turn = () => new Promise<void>((r) => process.nextTick(r));

function rig(existing?: ManagedPane) {
  const clock = heldClock(new Date(100));
  let physical = existing ?? null;
  const journal: string[] = [];
  const viewers: Viewers[] = [];
  const edge: BarPaneEdge = {
    find: jest.fn(async () => physical),
    open: jest.fn(
      async (_src, _pid, _host, instance) =>
        (physical = { drawing: "%2", instance }),
    ),
    retire: jest.fn(async () => {
      journal.push("retire");
      physical = null;
    }),
  };
  const feeds = new FrameFeeds({
    shown: () => true,
    watchingChanged: () => {},
    log: () => {},
    requestChanged: () => {},
    publishFrame: () => {
      throw Error("no frame expected");
    },
    acknowledgeDisplayed: () => {},
    deliver: async (make) => {
      viewers.push(make());
      return { kind: "answered" };
    },
  });
  const surfaces = new DeclaredSurfaces({
    clock,
    host,
    edge,
    log: (_level, msg) => journal.push(msg),
    paneOf: () => source,
    windows: () => {},
    interest: () => () => {},
    inPane: (_src, act) => act(),
    subscribe: (sid, sub, replaces) => feeds.subscribe(sid, sub, replaces),
    announce: () => feeds.announce(),
  });
  const observe = (
    withDrawing = true,
    shown = true,
    zoomed = false,
    mouse = true,
  ) => {
    const fact = { shown, zoomed, mouse, pid: 33, tty: "/dev/fixture" };
    const panes = new Map([[source.pane, fact]]);
    if (withDrawing) panes.set("%2", fact);
    surfaces.observed(source.socket, { serverPid: 10, panes });
  };
  const hello = (): PaneHello => {
    if (!physical) throw Error("no physical split");
    return {
      source: source.pane,
      socket: source.socket,
      serverPid: 10,
      followerPid: 33,
      ...physical,
    };
  };
  const stream: PaneStream = {
    disconnect: jest.fn(),
    update: jest.fn(),
    refused: (reason) => journal.push("refused " + reason),
  };
  const demand = () => {
    observe(false);
    surfaces.confirmed(source, a, 10);
    surfaces.declare({ [a]: enabled, [b]: enabled });
  };
  return {
    clock,
    edge,
    feeds,
    surfaces,
    observe,
    hello,
    stream,
    demand,
    journal,
    viewers,
    disappear: () => {
      physical = null;
      observe(false);
    },
    setPhysical: (p: ManagedPane) => {
      physical = p;
    },
  };
}

test("hidden and unknown placement retain the acknowledged handoff, move once on clear, and idle at the hidden rate", async () => {
  const r = rig();
  r.demand();
  await turn();
  expect(r.edge.open).toHaveBeenCalledTimes(1);
  expect(r.feeds.getStats().subscribers).toBe(0);
  r.observe();
  r.surfaces.enroll(r.hello(), r.stream);
  expect(r.feeds.viewers()[a]?.lanes).toEqual({
    pane: expect.objectContaining({ drawing: true }),
  });
  r.observe(true, false);
  expect(r.feeds.viewers()[a]).toMatchObject({
    shown: false,
    lanes: { pane: { subscribers: 1, drawing: true, pointer: null } },
  });
  r.surfaces.observed(source.socket, null);
  expect(r.feeds.getStats().subscribers).toBe(1);
  r.observe(true, true, true, false);
  expect(r.stream.update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      session: a,
      shown: true,
      zoomed: true,
      mouse: false,
    }),
    null,
  );
  const oldOwner = jest.mocked(r.stream.update).mock.lastCall![0].owner;
  const pointer = { id: oldOwner, pointer: { gestures: [], hover: "test" } };
  expect(r.feeds.pointerOf(a, pointer).kind).toBe("ok");
  const from = r.viewers.length;
  r.surfaces.confirmed(source, b, 10);
  expect(r.viewers.slice(from).map((v) => Object.keys(v))).toEqual([[b]]);
  expect(r.feeds.pointerOf(a, pointer).kind).toBe("refused");
  expect(r.stream.update).toHaveBeenLastCalledWith(
    expect.objectContaining({ session: b }),
    null,
  );
  expect(r.edge.open).toHaveBeenCalledTimes(1);
  r.surfaces.confirmed(source, a, 10);
  expect(r.feeds.pointerOf(a, pointer).kind).toBe("refused");
  r.surfaces.confirmed(source, b, 10);
  r.surfaces.declare({ [a]: enabled, [b]: off });
  expect(r.journal).toContain("refused tmux pane surface switched off");
  expect(r.edge.retire).not.toHaveBeenCalled();
  expect(r.feeds.viewers()).toEqual({});
  r.disappear();
  await turn();
  expect(r.edge.open).toHaveBeenCalledTimes(1);
});

test("the physical split is recoverable before the host gets its reply; a hanging-up hello cannot create another", async () => {
  const r = rig();
  let reply!: (v: ManagedPane) => void;
  jest
    .mocked(r.edge.open)
    .mockImplementationOnce(async (_s, _p, _h, instance) => {
      const committed = { drawing: "%2", instance };
      r.setPhysical(committed);
      return new Promise<ManagedPane>((resolve) => {
        reply = resolve;
      });
    });
  r.demand();
  await turn();
  const hello = r.hello();
  r.observe();
  const beforeReply = r.surfaces.enroll(hello, r.stream);
  beforeReply();
  expect(r.feeds.getStats().subscribers).toBe(0);
  r.surfaces.close();
  const next = rig({ drawing: hello.drawing, instance: hello.instance });
  next.observe();
  next.surfaces.enroll(hello, next.stream);
  await turn();
  expect(next.feeds.getStats().subscribers).toBe(0);
  next.surfaces.declare({ [a]: enabled });
  next.surfaces.confirmed(source, a, 10);
  await turn();
  expect(next.feeds.getStats().subscribers).toBe(1);
  expect(next.edge.open).not.toHaveBeenCalled();
  reply({ drawing: hello.drawing, instance: hello.instance });
  await turn();
  expect(r.feeds.getStats().subscribers).toBe(0);
});

test("socket loss reopens the stream on a surviving pane; physical death creates one replacement", async () => {
  const r = rig();
  r.demand();
  await turn();
  r.observe();
  const hello = r.hello();
  const lost = r.surfaces.enroll(hello, r.stream);
  lost();
  await turn();
  expect(r.feeds.getStats().subscribers).toBe(0);
  expect(r.edge.open).toHaveBeenCalledTimes(1);
  r.surfaces.enroll(hello, r.stream);
  expect(r.feeds.getStats().subscribers).toBe(1);
  r.disappear();
  await turn();
  expect(r.edge.open).toHaveBeenCalledTimes(2);
  expect(r.hello().instance).not.toEqual(hello.instance);
  r.observe();
  r.surfaces.enroll(hello, r.stream);
  expect(r.journal).toContain(
    "refused pane is not the managed drawing instance",
  );
  expect(r.feeds.getStats().subscribers).toBe(0);
  r.surfaces.enroll(r.hello(), r.stream);
  expect(r.feeds.getStats().subscribers).toBe(1);
});

test("a split that dies before enrollment reports once and never respawns on unrelated snapshots", async () => {
  const r = rig();
  jest
    .mocked(r.edge.open)
    .mockImplementationOnce(async (_s, _p, _h, instance) => ({
      drawing: "%2",
      instance,
    }));
  r.demand();
  await turn();
  r.observe(false);
  r.observe(false);
  r.surfaces.declare({ [a]: enabled });
  await turn();
  expect(r.edge.open).toHaveBeenCalledTimes(1);
  expect(
    r.journal.filter((s) => s.includes("exited before it enrolled")),
  ).toHaveLength(1);
});

test("a dormant old invocation blocks duplicate setup until its exact physical pane disappears", async () => {
  const r = rig();
  jest.mocked(r.edge.find).mockResolvedValueOnce({
    drawing: "%2",
    pid: 33,
    command: "legacy",
    grant: "unknown",
  });
  r.demand();
  await turn();
  r.observe();
  r.surfaces.declare({ [a]: enabled });
  await turn();
  expect(r.edge.open).not.toHaveBeenCalled();
  expect(r.edge.retire).not.toHaveBeenCalled();
  expect(
    r.journal.filter((line) =>
      line.includes("cannot verify its daemon socket"),
    ),
  ).toHaveLength(1);
  r.disappear();
  await turn();
  expect(r.edge.open).toHaveBeenCalledTimes(1);
});

test("confirmed release of the physical source removes its prior session membership immediately", async () => {
  const r = rig();
  r.demand();
  await turn();
  r.observe();
  r.surfaces.enroll(r.hello(), r.stream);
  expect(r.feeds.getStats().subscribers).toBe(1);
  r.surfaces.confirmed(source, null, 10);
  expect(r.feeds.getStats().subscribers).toBe(0);
  expect(r.journal).toContain("refused source pane closed");
  r.disappear();
  await turn();
  expect(r.edge.open).toHaveBeenCalledTimes(1);
});

test.each([false, true])(
  "a new confirmed report rediscovers an unacknowledged split (committed=%s)",
  async (committed) => {
    const r = rig();
    jest
      .mocked(r.edge.open)
      .mockImplementationOnce(async (_src, _pid, _host, instance) => {
        if (committed) r.setPhysical({ drawing: "%2", instance });
        throw new Error("split reply lost");
      });
    r.demand();
    await turn();
    expect(r.edge.open).toHaveBeenCalledTimes(1);
    const activity = r.clock.activity();
    expect(r.clock.pending()).toBe(0);
    r.clock.advance(60_000);
    await turn();
    expect(r.clock.activity()).toEqual(activity);
    expect(r.edge.open).toHaveBeenCalledTimes(1);
    const refused = jest.fn(async () => false);
    r.surfaces.retryOnReport(source, a, refused);
    await turn();
    expect(refused).toHaveBeenCalledTimes(1);
    expect(r.edge.open).toHaveBeenCalledTimes(1);
    r.clock.advance(1000);
    const proof = Promise.withResolvers<boolean>();
    const verify = jest.fn(() => proof.promise);
    r.surfaces.retryOnReport(source, a, verify);
    r.surfaces.retryOnReport(source, a, verify);
    expect(verify).toHaveBeenCalledTimes(1);
    jest.mocked(r.edge.find).mockClear();
    proof.resolve(true);
    await turn();
    const firstLookup = jest.mocked(r.edge.find).mock.invocationCallOrder[0];
    expect(firstLookup).toBeDefined();
    expect(r.edge.open).toHaveBeenCalledTimes(committed ? 1 : 2);
    if (!committed)
      expect(firstLookup!).toBeLessThan(
        jest.mocked(r.edge.open).mock.invocationCallOrder[1]!,
      );
  },
);

test("switching off while a retry is being verified cancels its split", async () => {
  const r = rig();
  jest.mocked(r.edge.open).mockRejectedValueOnce(new Error("split reply lost"));
  r.demand();
  await turn();
  r.clock.advance(1000);
  const proof = Promise.withResolvers<boolean>();
  r.surfaces.retryOnReport(source, a, () => proof.promise);
  r.surfaces.declare({ [a]: off });
  proof.resolve(true);
  await turn();
  expect(r.edge.open).toHaveBeenCalledTimes(1);
});

test("a snapshot's unfinished discovery can consume a report verified during its lookup", async () => {
  const r = rig();
  jest.mocked(r.edge.open).mockRejectedValueOnce(new Error("split reply lost"));
  r.demand();
  await turn();
  r.clock.advance(1000);
  const proof = Promise.withResolvers<boolean>();
  r.surfaces.retryOnReport(source, a, () => proof.promise);
  const found = Promise.withResolvers<null>();
  jest.mocked(r.edge.find).mockReturnValueOnce(found.promise);
  r.observe(false);
  proof.resolve(true);
  await turn();
  expect(r.edge.open).toHaveBeenCalledTimes(1);
  found.resolve(null);
  await turn();
  expect(r.edge.open).toHaveBeenCalledTimes(2);
});
