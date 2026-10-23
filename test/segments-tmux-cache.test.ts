import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NAME_PERIOD_MS, TmuxService } from "../src/segments/tmux";
import { Holds } from "../src/utils/holds";
import {
  setLaunchStats,
  __resetRateLimitsForTest,
} from "../src/proc/launch";
import type { LaunchCategory } from "../src/proc/launch";
import type { LaunchStatsHandle } from "../src/proc/stats-handle";
import type { TmuxHint } from "../src/tmux-hint";

// [LAW:behavior-not-structure] A stub `tmux` on PATH answers every invocation
// with its own arguments, so the session name a lookup returns IS the server
// and pane it asked — the contract under test (brandon-tmux-tk7: the pane the
// session's client reported, never the daemon's own TMUX/TMUX_PANE). A socket
// path containing `refuse` exits non-zero, standing in for a server that is
// not there, and a `renamed` file beside the stub is the name tmux answers
// with from then on.
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-stub-"));
fs.writeFileSync(
  path.join(bin, "tmux"),
  '#!/bin/sh\ncase "$2" in *refuse*) echo "no server running on $2" >&2; exit 1;; esac\nif [ -f "$0.renamed" ]; then cat "$0.renamed"; else echo "$*"; fi\n',
  { mode: 0o755 },
);

const SAVED = {
  PATH: process.env.PATH,
  TMUX: process.env.TMUX,
  TMUX_PANE: process.env.TMUX_PANE,
};
const restore = (key: keyof typeof SAVED): void => {
  if (SAVED[key] === undefined) delete process.env[key];
  else process.env[key] = SAVED[key];
};

const hint = (socket: string, pane: string): TmuxHint => ({
  socket,
  pane,
  truecolor: null,
});
const asked = (h: TmuxHint): string =>
  `-S ${h.socket} display-message -p -t ${h.pane} #S`;

let starts: LaunchCategory[];
let svc: TmuxService;
let holds: Holds;

// Polls a condition a spawn settles: a period's read is answered by a real
// process, so the test has no promise of it to await.
const until = async (cond: () => boolean | Promise<boolean>): Promise<void> => {
  while (!(await cond())) await new Promise((r) => setImmediate(r));
};

// [LAW:no-ambient-temporal-coupling] The period is a timer, so it is driven by
// the clock; the stub's answer is real I/O, which is why `setImmediate` (the
// poll above) keeps running on the real loop.
const fakeClock = (): void => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask"] });
};

beforeAll(() => {
  process.env.PATH = `${bin}${path.delimiter}${SAVED.PATH ?? ""}`;
  // The daemon's own shell sits in some other pane of some other server.
  process.env.TMUX = "/daemon/shell.sock,1,0";
  process.env.TMUX_PANE = "%99";
});

afterAll(() => {
  restore("PATH");
  restore("TMUX");
  restore("TMUX_PANE");
  fs.rmSync(bin, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(bin, "tmux.renamed"), { force: true });
  __resetRateLimitsForTest();
  starts = [];
  const handle: LaunchStatsHandle = {
    onStart: (c) => starts.push(c),
    onEnd: () => {},
  };
  setLaunchStats(handle);
  svc = new TmuxService();
  holds = new Holds();
});

afterEach(() => {
  svc.close();
  setLaunchStats(null);
  jest.useRealTimers();
});

describe("TmuxService", () => {
  it("asks the server and pane the client reported, not the daemon's env", async () => {
    const h = hint("/client/a.sock", "%7");
    expect(await svc.getSessionName(holds, h)).toEqual({
      kind: "ok",
      value: asked(h),
    });
  });

  it("a read takes the stored name: tmux is asked once between periods", async () => {
    const h = hint("/client/a.sock", "%7");
    await svc.getSessionName(holds, h);
    await svc.getSessionName(holds, h);
    await svc.getSessionName(holds, { ...h, truecolor: "1" });
    expect(starts).toEqual(["tmux"]);
  });

  it("concurrent calls for one pane share one invocation", async () => {
    const h = hint("/client/a.sock", "%7");
    const [a, b] = await Promise.all([
      svc.getSessionName(holds, h),
      svc.getSessionName(holds, h),
    ]);
    expect(a).toBe(b);
    expect(starts).toEqual(["tmux"]);
  });

  it("learns a renamed session on its period while held, drawing the old name meanwhile", async () => {
    fakeClock();
    const h = hint("/client/a.sock", "%7");
    const old = await svc.getSessionName(holds, h);
    fs.writeFileSync(path.join(bin, "tmux.renamed"), "renamed\n");

    await jest.advanceTimersByTimeAsync(NAME_PERIOD_MS - 1);
    expect(await svc.getSessionName(holds, h)).toBe(old);
    expect(starts).toEqual(["tmux"]);

    await jest.advanceTimersByTimeAsync(1);
    expect(starts).toEqual(["tmux", "tmux"]);
    await until(async () => (await svc.getSessionName(holds, h)) !== old);
    expect(await svc.getSessionName(holds, h)).toEqual({
      kind: "ok",
      value: "renamed",
    });
    expect(svc.getStats().refreshes).toEqual({
      first: 1,
      period: 1,
      supersede: 0,
    });
  });

  it("a pane nobody holds costs no spawn on its period", async () => {
    fakeClock();
    const h = hint("/client/a.sock", "%7");
    await svc.getSessionName(holds, h);
    holds.releaseUnread();
    holds.releaseUnread();
    await jest.advanceTimersByTimeAsync(NAME_PERIOD_MS * 3);
    expect(starts).toEqual(["tmux"]);
    expect(svc.getStats()).toMatchObject({ entries: 1, held: 0 });
  });

  it("two panes of one server each get their own answer", async () => {
    const a = hint("/client/a.sock", "%1");
    const b = hint("/client/a.sock", "%2");
    expect(await svc.getSessionName(holds, a)).toEqual({ kind: "ok", value: asked(a) });
    expect(await svc.getSessionName(holds, b)).toEqual({ kind: "ok", value: asked(b) });
    expect(starts).toEqual(["tmux", "tmux"]);
  });

  it("one pane id on two servers is two panes", async () => {
    const a = hint("/client/a.sock", "%1");
    const b = hint("/client/b.sock", "%1");
    expect(await svc.getSessionName(holds, a)).toEqual({ kind: "ok", value: asked(a) });
    expect(await svc.getSessionName(holds, b)).toEqual({ kind: "ok", value: asked(b) });
  });

  it("a server that refuses is a failure naming tmux's reason, logged once and asked again on its period", async () => {
    fakeClock();
    const lines: string[] = [];
    svc.close();
    svc = new TmuxService({ logger: (level, msg) => lines.push(`${level} ${msg}`) });
    const h = hint("/client/refuse.sock", "%1");
    const first = await svc.getSessionName(holds, h);
    expect(first.kind).toBe("failed");
    expect(first).toMatchObject({
      reason: expect.stringContaining("no server running on /client/refuse.sock"),
    });
    expect(await svc.getSessionName(holds, h)).toBe(first);
    expect(starts).toEqual(["tmux"]);
    expect(lines).toEqual([
      expect.stringMatching(/^warn tmux refresh pane=%1 socket=\/client\/refuse.sock stored=Y by=first outcome=failed reason=".*no server running on \/client\/refuse.sock.*" took=\d+ms$/),
    ]);

    await jest.advanceTimersByTimeAsync(NAME_PERIOD_MS);
    await until(() => starts.length === 2);
  });
});
