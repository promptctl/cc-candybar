import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TmuxService,
  __resetTmuxCacheForTest,
} from "../src/segments/tmux";
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
// not there.
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-stub-"));
fs.writeFileSync(
  path.join(bin, "tmux"),
  '#!/bin/sh\ncase "$2" in *refuse*) echo "no server running on $2" >&2; exit 1;; esac\necho "$*"\n',
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
  __resetTmuxCacheForTest();
  __resetRateLimitsForTest();
  starts = [];
  const handle: LaunchStatsHandle = {
    onStart: (c) => starts.push(c),
    onEnd: () => {},
  };
  setLaunchStats(handle);
});

afterEach(() => {
  setLaunchStats(null);
});

describe("TmuxService", () => {
  it("asks the server and pane the client reported, not the daemon's env", async () => {
    const h = hint("/client/a.sock", "%7");
    expect(await new TmuxService().getSessionId(h)).toEqual({
      kind: "ok",
      value: asked(h),
    });
  });

  it("asks once per pane, across calls and instances", async () => {
    const h = hint("/client/a.sock", "%7");
    await new TmuxService().getSessionId(h);
    await new TmuxService().getSessionId(h);
    await new TmuxService().getSessionId({ ...h, truecolor: "1" });
    expect(starts).toEqual(["tmux"]);
  });

  it("two panes of one server each get their own answer", async () => {
    const svc = new TmuxService();
    const a = hint("/client/a.sock", "%1");
    const b = hint("/client/a.sock", "%2");
    expect(await svc.getSessionId(a)).toEqual({ kind: "ok", value: asked(a) });
    expect(await svc.getSessionId(b)).toEqual({ kind: "ok", value: asked(b) });
    expect(starts).toEqual(["tmux", "tmux"]);
  });

  it("one pane id on two servers is two panes", async () => {
    const svc = new TmuxService();
    const a = hint("/client/a.sock", "%1");
    const b = hint("/client/b.sock", "%1");
    expect(await svc.getSessionId(a)).toEqual({ kind: "ok", value: asked(a) });
    expect(await svc.getSessionId(b)).toEqual({ kind: "ok", value: asked(b) });
  });

  it("a server that refuses is a failure naming tmux's reason, asked once", async () => {
    const svc = new TmuxService();
    const h = hint("/client/refuse.sock", "%1");
    const first = await svc.getSessionId(h);
    expect(first.kind).toBe("failed");
    expect(first).toMatchObject({
      reason: expect.stringContaining("no server running on /client/refuse.sock"),
    });
    expect(await svc.getSessionId(h)).toBe(first);
    expect(starts).toEqual(["tmux"]);
  });
});
