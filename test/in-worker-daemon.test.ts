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
import { setImmediate } from "node:timers";

import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { CLICK_ERROR_HOLD_S } from "../src/daemon/click-error";
import { logPath } from "../src/daemon/paths";
import {
  encodeFrame,
  makeFrameReader,
  PROTOCOL_VERSION,
  type Request,
  type Response,
} from "../src/daemon/protocol";
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
import { startDaemon, type InWorkerDaemon } from "./helpers/in-worker-daemon";
import { JEST_TMP_PREFIX, jestTmpOwner } from "./helpers/jest-tmp";
import { prepareIsolatedDaemonEnv } from "./helpers/spawn-isolated-daemon";
import { until } from "./helpers/until";

jest.setTimeout(30_000);

const CONFIG = `{
  actions: { wide: { set: "padding", to: "4" } },
  segments: {
    pad: { template: '{{ action "wide" "[wide]" }}', bg: "surface", fg: "foreground" },
  },
  root: { h: ["pad"] },
}`;

// A render of this waits on a source no client outlasts.
const WAITING_CONFIG = `{ variables: { doc: { kind: 'shell', command: 'sleep 60', cache: { never: true } } }, segments: { mark: { template: '{{ .doc }}' } }, root: { h: ['mark'] } }`;

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

  test("a TIMEOUT is the helper's to ask again", async () => {
    daemon = startDaemon(env);
    const { send, log } = daemon;
    let asked = 0;
    const out = await renderRequest(
      {
        log,
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

  // A socket's peer that vanishes ends the daemon's side at once. The daemon's
  // own answer ends the connection a little later whatever happened, so what
  // shows the hang-up is that it needed no answer: a memory stream's close has
  // landed a macrotask on.
  test("a client that gives up hangs up the daemon's end", async () => {
    writeFileSync(userConfig, WAITING_CONFIG);
    daemon = startDaemon(env);
    const { stats } = daemon.daemon;

    await expect(
      daemon.send(
        {
          v: PROTOCOL_VERSION,
          kind: "render",
          ...renderBody("in-worker-gave-up", projectDir),
          deadline: Date.now() + 5_000,
        },
        20,
      ),
    ).rejects.toThrow("TIMEOUT");

    await new Promise((resolve) => setImmediate(resolve));
    expect(stats.inFlight).toBe(0);
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

  test("a stop ends a subscriber's stream and a request's backstop, and gives the env back", async () => {
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
    const { stats } = daemon.daemon;
    await until(() => stats.inFlight === 0, "the subscribe leaving in-flight");

    // Open and silent: its backstop is armed, and only its stream's close takes
    // it out of in-flight.
    daemon.connect();
    expect(stats.inFlight).toBe(1);

    await daemon.stop();
    daemon = null;

    await until(() => closed, "the subscriber hearing the daemon go");
    expect(stats.inFlight).toBe(0);
    expect(stats.requestsTimedOut).toBe(0);
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
