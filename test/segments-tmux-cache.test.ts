import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TmuxService } from "../src/segments/tmux";
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

// Polls a condition the refetch settles: the expired reading is answered at
// once, so the test has no promise of the refetch to await.
const until = async (cond: () => boolean | Promise<boolean>): Promise<void> => {
  while (!(await cond())) await new Promise((r) => setImmediate(r));
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
});

afterEach(() => {
  setLaunchStats(null);
});

describe("TmuxService", () => {
  it("asks the server and pane the client reported, not the daemon's env", async () => {
    const h = hint("/client/a.sock", "%7");
    expect(await new TmuxService().getSessionName(h)).toEqual({
      kind: "ok",
      value: asked(h),
    });
  });

  it("asks once while a pane's reading stands", async () => {
    const svc = new TmuxService();
    const h = hint("/client/a.sock", "%7");
    await svc.getSessionName(h);
    await svc.getSessionName(h);
    await svc.getSessionName({ ...h, truecolor: "1" });
    expect(starts).toEqual(["tmux"]);
  });

  it("concurrent calls for one pane share one invocation", async () => {
    const svc = new TmuxService();
    const h = hint("/client/a.sock", "%7");
    const [a, b] = await Promise.all([
      svc.getSessionName(h),
      svc.getSessionName(h),
    ]);
    expect(a).toBe(b);
    expect(starts).toEqual(["tmux"]);
  });

  it("learns a renamed session once the reading expires, drawing the old name meanwhile", async () => {
    let now = 0;
    const svc = new TmuxService(() => now);
    const h = hint("/client/a.sock", "%7");
    const old = await svc.getSessionName(h);
    fs.writeFileSync(path.join(bin, "tmux.renamed"), "renamed\n");

    now = 29_999;
    expect(await svc.getSessionName(h)).toBe(old);
    expect(starts).toEqual(["tmux"]);

    now = 30_000;
    expect(await svc.getSessionName(h)).toBe(old);
    await until(() => starts.length === 2);
    await until(async () => (await svc.getSessionName(h)) !== old);
    expect(await svc.getSessionName(h)).toEqual({
      kind: "ok",
      value: "renamed",
    });
    expect(starts).toEqual(["tmux", "tmux"]);
  });

  it("two panes of one server each get their own answer", async () => {
    const svc = new TmuxService();
    const a = hint("/client/a.sock", "%1");
    const b = hint("/client/a.sock", "%2");
    expect(await svc.getSessionName(a)).toEqual({ kind: "ok", value: asked(a) });
    expect(await svc.getSessionName(b)).toEqual({ kind: "ok", value: asked(b) });
    expect(starts).toEqual(["tmux", "tmux"]);
  });

  it("one pane id on two servers is two panes", async () => {
    const svc = new TmuxService();
    const a = hint("/client/a.sock", "%1");
    const b = hint("/client/b.sock", "%1");
    expect(await svc.getSessionName(a)).toEqual({ kind: "ok", value: asked(a) });
    expect(await svc.getSessionName(b)).toEqual({ kind: "ok", value: asked(b) });
  });

  it("a server that refuses is a failure naming tmux's reason, asked again only once it expires", async () => {
    let now = 0;
    const svc = new TmuxService(() => now);
    const h = hint("/client/refuse.sock", "%1");
    const first = await svc.getSessionName(h);
    expect(first.kind).toBe("failed");
    expect(first).toMatchObject({
      reason: expect.stringContaining("no server running on /client/refuse.sock"),
    });
    expect(await svc.getSessionName(h)).toBe(first);
    expect(starts).toEqual(["tmux"]);

    now = 30_000;
    await svc.getSessionName(h);
    await until(() => starts.length === 2);
  });
});
