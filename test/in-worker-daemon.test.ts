// [LAW:verifiable-goals] The harness a daemon-backed test stands on: a daemon in
// this jest worker, reached through the e2e helpers over the connection a socket
// gets, stopped with nothing of it left serving, and started again over the same
// state. Its cases hold what a migrated file would otherwise find out by failing.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { CLICK_ERROR_HOLD_S } from "../src/daemon/click-error";
import { dlog, logLines } from "../src/daemon/log";
import { logPath } from "../src/daemon/paths";
import {
  encodeFrame,
  makeFrameReader,
  PROTOCOL_VERSION,
  type Request,
  type Response,
} from "../src/daemon/protocol";
import { REQUEST_TIMEOUT_MS } from "../src/daemon/request-deadline";
import { sweepJestTmp } from "./global-teardown";
import {
  click,
  linkUrls,
  render,
  renderBody,
  renderRequest,
  renderUntil,
  sendClick,
  stripAnsi,
} from "./helpers/daemon-e2e";
import { renderLines } from "./helpers/daemon-log";
import {
  heldClock,
  startDaemon,
  type InWorkerDaemon,
} from "./helpers/in-worker-daemon";
import { JEST_TMP_PREFIX, jestTmpDir, jestTmpOwner } from "./helpers/jest-tmp";
import { prepareIsolatedDaemonEnv } from "./helpers/spawn-isolated-daemon";
import { throughout, until } from "./helpers/until";

jest.setTimeout(30_000);

const CONFIG = `{
  globals: { experimentalStatusline: true },
  actions: { wide: { set: "padding", to: "4" } },
  segments: {
    pad: { template: '{{ action "wide" "[wide]" }}', bg: "surface", fg: "foreground" },
  },
  root: { h: ["pad"] },
}`;

describe("a daemon in this worker", () => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let userConfig: string;
  let daemon: InWorkerDaemon | null = null;

  const width = (bar: string): number => stripAnsi(bar).trimEnd().length;

  beforeEach(() => {
    const prepared = prepareIsolatedDaemonEnv("ccb-in-worker");
    ({ env, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-in-worker-"));
    const configDir = path.join(env.XDG_CONFIG_HOME!, "cc-candybar");
    mkdirSync(configDir, { recursive: true });
    userConfig = path.join(configDir, "config.json5");
    writeFileSync(userConfig, CONFIG);
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("the e2e helpers draw through it, click it, and read its events", async () => {
    const sid = "in-worker-draw";
    daemon = startDaemon(env);
    const before = await render(daemon, sid, projectDir);
    expect(stripAnsi(before)).toContain("[wide]");

    await click(daemon, linkUrls(before)[0]!);

    await renderUntil(
      daemon,
      sid,
      projectDir,
      (bar) => width(bar) > width(before),
      "the bar the click widened",
    );
    expect(await renderLines(env, sid, 2)).not.toEqual([]);
  });

  // [LAW:verifiable-goals] An answer carries a failed click's error only once
  // it has flushed. Past the hold, an error an answer carried is over, and one
  // none carried is still owed, so `over` is `delivered` having run.
  test("a reply's delivered runs once its answer has flushed", async () => {
    const sid = "in-worker-delivered";
    let now = Date.now();
    daemon = startDaemon(env, {
      clock: { date: () => new Date(now), monotonic: () => performance.now() },
    });
    await render(daemon, sid, projectDir);
    const refused = await sendClick(
      daemon,
      effectsUrl([{ verb: VERB_SET_STATE, args: [sid, "no-such-key", "x"] }]),
    );
    expect(refused.ok).toBe(false);
    await render(daemon, sid, projectDir);

    now += (CLICK_ERROR_HOLD_S + 1) * 1000;
    await render(daemon, sid, projectDir);

    const events = await renderLines(env, sid, 3);
    expect(events.at(-1)).toContain(" clickError=over ");
  });

  // [LAW:one-source-of-truth] A request's budget is its deadline less its
  // arrival, so a held daemon's client states the deadline on the daemon's clock.
  // 120 ms is under the backstop the wait clamps to, and less the reserve it
  // is not the figure an unstated deadline gets, so the event's figure is that
  // deadline's and nothing else's.
  test("a client of a held daemon states its deadline on that daemon's clock", async () => {
    const sid = "in-worker-held";
    const clock = heldClock(new Date(Date.now() - 60_000));
    daemon = startDaemon(env, { clock });
    clock.advance(5_000);
    await renderRequest(daemon, {
      ...renderBody(sid, projectDir),
      deadline: daemon.now() + 120,
    });
    const [event] = await renderLines(env, sid);
    expect(event).toContain(" deadline=stated:80ms ");
  });

  test("a start refused beside a live daemon leaves it the env it reads", () => {
    daemon = startDaemon(env);
    const placed = { ...process.env };
    expect(() =>
      startDaemon({ ...env, XDG_STATE_HOME: path.join(projectDir, "other") }),
    ).toThrow("a daemon is already live in this process");
    expect({ ...process.env }).toEqual(placed);
  });

  test("a TIMEOUT is the helper's to ask again", async () => {
    daemon = startDaemon(env);
    const { send, log, now } = daemon;
    let asked = 0;
    const out = await renderRequest(
      {
        log,
        now,
        send: (req, budgetMs) =>
          ++asked === 1
            ? Promise.resolve({ ok: false, error: "slow", code: "TIMEOUT" })
            : send(req, budgetMs),
      },
      renderBody("in-worker-timeout", projectDir),
    );
    expect(stripAnsi(out)).toContain("[wide]");
    expect(asked).toBeGreaterThan(1);
  });

  test("a start over the same env sees what the stopped daemon left", async () => {
    const sid = "in-worker-restart";
    daemon = startDaemon(env);
    const before = await render(daemon, sid, projectDir);
    await click(daemon, linkUrls(before)[0]!);
    await daemon.stop();

    daemon = startDaemon(env);
    expect(width(await render(daemon, sid, projectDir))).toBeGreaterThan(
      width(before),
    );
  });

  test("a stop ends a subscriber's stream and a request's backstop, lands the log, and gives the env back", async () => {
    const sid = "in-worker-stop";
    const stateHome = process.env.XDG_STATE_HOME;
    daemon = startDaemon(env);
    expect(process.env.XDG_STATE_HOME).toBe(env.XDG_STATE_HOME);
    expect(daemon.log).toBe(logPath(env));
    await render(daemon, sid, projectDir);

    const subscriber = daemon.connect();
    const frames: Response[] = [];
    let closed = false;
    subscriber.on(
      "data",
      makeFrameReader(
        (frame) => frames.push(frame as Response),
        (err) => {
          throw err;
        },
      ),
    );
    subscriber.on("close", () => (closed = true));
    const subscribe: Request = {
      v: PROTOCOL_VERSION,
      kind: "subscribe",
      sessionId: sid,
      lane: "statusline",
    };
    subscriber.write(encodeFrame(subscribe));
    // A refusal is a frame too, and it closes the stream, so what shows a
    // subscriber is a frame it drew on a stream still open.
    await until(() => frames.length > 0, "the subscriber's first frame");
    expect(frames[0]).toMatchObject({ ok: true });
    expect(closed).toBe(false);
    const { stats } = daemon.daemon;
    expect(stats.inFlight).toBe(0);

    // Open and silent: its backstop is armed, and only its stream's close takes
    // it out of in-flight. A cold render above may have timed out on its own, so
    // the count is read from here.
    const timedOut = stats.requestsTimedOut;
    daemon.connect();
    expect(stats.inFlight).toBe(1);

    // Logged with the env placed, so it belongs in this daemon's log, and the
    // log reads its path when it writes.
    const last = "the last line before the stop";
    dlog("info", last);
    const { log } = daemon;
    await daemon.stop();
    daemon = null;
    expect(logLines(log).join("\n")).toContain(last);

    await until(() => closed, "the subscriber hearing the daemon go");
    expect(stats.inFlight).toBe(0);
    await throughout(
      () => stats.requestsTimedOut === timedOut,
      "the stopped connection's backstop staying quiet",
      REQUEST_TIMEOUT_MS * 2,
    );
    expect(process.env.XDG_STATE_HOME).toBe(stateHome);
  });
});

describe("the sweep over jest's directories", () => {
  let root: string;

  const dirNamed = (name: string): string => {
    mkdirSync(path.join(root, name));
    return name;
  };
  const ownedBy = (pid: number): string =>
    dirNamed(`${JEST_TMP_PREFIX}state-${pid}-a-uuid`);

  // Exited by the time this returns, so nothing holds its pid.
  const deadPid = (): number =>
    spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-sweep-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a directory's name says the worker that made it, or says none", () => {
    expect(jestTmpOwner(`${JEST_TMP_PREFIX}state-4242-a-uuid`)).toBe(4242);
    expect(jestTmpOwner(`${JEST_TMP_PREFIX}daemon-pool`)).toBeNull();
    expect(jestTmpOwner(path.basename(jestTmpDir("state")))).toBe(process.pid);
  });

  test("keeps another live process's directory and removes the rest", () => {
    const another = ownedBy(process.ppid);
    const dead = ownedBy(deadPid());
    const own = ownedBy(process.pid);
    const unnamed = dirNamed(`${JEST_TMP_PREFIX}a-uuid`);
    const unrelated = dirNamed("something-else");

    sweepJestTmp(root, process.pid);

    expect(readdirSync(root).sort()).toEqual([another, unrelated].sort());
    for (const gone of [dead, own, unnamed])
      expect(existsSync(path.join(root, gone))).toBe(false);
  });
});
