// [LAW:verifiable-goals] The harness a daemon-backed test stands on: a daemon in
// this jest worker, reached through the e2e helpers over the connection a socket
// gets, stopped with nothing of it left serving, and started again over the same
// state. Its cases hold what a migrated file would otherwise find out by failing.

import type { RequestId } from "../../../src/renderer-interface/interface";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostOf } from "../../helpers/host";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { effectsUrl, VERB_COPY, VERB_OPEN_VSCODE, VERB_SET_STATE } from "../../../src/click/wire";
import { CLICK_ERROR_HOLD_S } from "../../../src/daemon/foundations/click-error";
import { systemTimekeeper } from "../../../src/time";
import { createLauncher, LIFELINE_PROGRAM } from "../../../src/proc/launch";
import { exits, fakeSpawner, readsStdin } from "../../../src/proc/spawner-fake";
import { DAEMON_EVENT_HOLD_S } from "../../../src/utils/event-hold";
import { fakeLauncher, type FakeLauncher } from "../../helpers/fake-launcher";
import { indicatorOf, readDiagnostics } from "../../helpers/diagnostics-viewer";
import { TEST_ENV } from "../../helpers/session-environment";
import { logLines } from "../../../src/daemon/log";
import { logPath } from "../../../src/daemon/paths";
import {
  encodeFrame,
  makeFrameReader,
  PROTOCOL_VERSION,
  type ReaderRenderRequest,
  type Request,
  type Response,
} from "../../../src/daemon/foundations/protocol";
import {
  DRAW_RESERVE_MS,
  REQUEST_TIMEOUT_MS,
} from "../../../src/daemon/foundations/request-deadline";
import { parseFrame, textOf, type Frame } from "../../../src/render/frame";
import {
  click,
  findUrl,
  frameRequest,
  render,
  renderBody,
  renderRequest,
  renderUntil,
  refusedClick,
  drawnLink,
} from "../../helpers/daemon-e2e";
import { renderLines } from "../../helpers/daemon-log";
import { linkUrls } from "../../helpers/frame";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { heldClock } from "../../helpers/held-clock";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { throughout, until } from "../../helpers/until";

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

  const width = (bar: Frame): number => textOf(bar).trimEnd().length;

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
    expect(textOf(before)).toContain("[wide]");

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

  test.each([
    { verb: VERB_COPY, bin: "/usr/bin/pbcopy", category: "click.pbcopy" },
    { verb: VERB_OPEN_VSCODE, bin: "/usr/bin/open", category: "click.open" },
  ] as const)("the bar reports a rate-limited $verb launch", async ({ verb, bin, category }) => {
    const sid = "rate-limited-desktop-click";
    // The launcher measures both clicks in the same interval. Its fake child
    // exits on the normal event loop, while the daemon's request clock runs.
    const startedAt = systemTimekeeper.monotonic();
    let fake: FakeLauncher | undefined;
    daemon = startDaemon(env, {
      launcher: (own) => {
        const launcher = fakeLauncher(
          { ...systemTimekeeper, monotonic: () => startedAt },
          own,
        );
        launcher.spawner.program((program) => program === bin, exits());
        fake = launcher;
        return launcher.launcher;
      },
    });
    await render(daemon, sid, projectDir);
    const url = drawnLink(daemon, effectsUrl([
      { verb, args: ["fixture"] },
      { verb: VERB_SET_STATE, args: [sid, "padding", "4"] },
    ]));
    await click(daemon, url);
    await refusedClick(daemon, url, "threw");

    const after = await render(daemon, sid, projectDir);
    expect(indicatorOf(after)).toBe("⚠ 1");
    const messages = await readDiagnostics(daemon, sid, projectDir, after);
    expect(messages.map(({ text }) => text).join(" ")).toContain(`rate-limited: ${category}`);
    expect(fake?.started().filter((item) => item.bin === bin)).toHaveLength(1);
  });

  // [LAW:verifiable-goals] An answer carries a failed click's error only once
  // it has flushed. Past the hold, an error an answer carried is over, and one
  // none carried is still owed, so `over` is `delivered` having run.
  test("a reply's delivered runs once its answer has flushed", async () => {
    const sid = "in-worker-delivered";
    let now = Date.now();
    daemon = startDaemon(env, {
      clock: { ...systemTimekeeper, now: () => now },
    });
    await render(daemon, sid, projectDir);
    await refusedClick(
      daemon,
      drawnLink(daemon, effectsUrl([{ verb: VERB_SET_STATE, args: [sid, "no-such-key", "x"] }])),
      "bad-request",
    );
    await render(daemon, sid, projectDir);

    now += (CLICK_ERROR_HOLD_S + 1) * 1000;
    await render(daemon, sid, projectDir);

    const events = await renderLines(env, sid, 3);
    expect(events.at(-1)).toContain(" clickError=over ");
  });

  test("a confirmed statusline write answers the daemon's act and launch pipe warnings", async () => {
    const sid = "warning-owners";
    const bin = "/usr/bin/pbcopy";
    const spawner = fakeSpawner(systemTimekeeper);
    spawner.program(
      (program, args) => program === "awk" && args[0] === LIFELINE_PROGRAM,
      readsStdin("until-end"),
    );
    spawner.program((program) => program === bin, exits(1));
    // [LAW:effects-at-boundaries] Only the child and its inherited stream
    // are simulated. The launcher owns the late read failure and its receipt.
    const pipe = Object.assign(new PassThrough(), { unref() {} });
    let now = Date.now();
    const running = startDaemon(env, {
      clock: { ...systemTimekeeper, now: () => now },
      launcher: (owner) =>
        createLauncher(owner, systemTimekeeper, {
          ...spawner,
          spawn: (program, args, options) => {
            const child = spawner.spawn(program, args, options);
            return program === bin
              ? Object.assign(child, { stdout: pipe })
              : child;
          },
        }),
    });
    daemon = running;
    const pipeEvent = () =>
      running.daemon.launcher
        .standing()
        .find((fact) => fact.kind === "launch-pipes")?.event;
    const pending = async () => {
      const { resp, settled } = await running.daemon.reply(
        {
          ...renderBody(sid, projectDir),
          v: PROTOCOL_VERSION,
          kind: "render",
          encoding: "frame",
        } as ReaderRenderRequest,
        () => false,
        running.daemon.stats.accept(),
        () => false,
      );
      if (!resp.ok || !("frame" in resp))
        throw new Error(`expected a frame: ${JSON.stringify(resp)}`);
      return { frame: parseFrame(resp.frame), settled };
    };
    try {
      const url = drawnLink(
        running,
        effectsUrl([{ verb: VERB_COPY, args: ["copy failure"] }]),
      );
      await refusedClick(running, url, "threw");
      expect(spawner.spawned.find((child) => child.bin === bin)?.stdin).toBe(
        "copy failure",
      );
      pipe.destroy(new Error("fixture cannot read the inherited pipe"));
      await until(
        () => pipeEvent() !== undefined,
        "the actual launcher's pipe warning",
      );
      expect(pipeEvent()).toMatchObject({
        answered: false,
        text: expect.stringContaining("output failed to read"),
      });

      // Only a confirmed write can clear either event from the statusline's
      // owed state after its hold. No other render confirms while we check it.
      const dropped = await pending();
      expect(indicatorOf(dropped.frame)).toBe("⚠ 2");
      dropped.settled(false);
      now += (DAEMON_EVENT_HOLD_S + 1) * 1000;
      const owed = await pending();
      expect(indicatorOf(owed.frame)).toBe("⚠ 2");
      expect(pipeEvent()?.answered).toBe(false);
      owed.settled(false);

      expect(indicatorOf(await render(running, sid, projectDir))).toBe("⚠ 2");
      expect(pipeEvent()?.answered).toBe(true);
      const after = await pending();
      expect(indicatorOf(after.frame)).toBeNull();
      after.settled(false);
    } finally {
      pipe.destroy();
    }
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
    expect(event).toContain(` deadline=stated:${120 - DRAW_RESERVE_MS}ms `);
  });

  test("the env is held until the last daemon over it stops, however often one is stopped", async () => {
    const before = { ...process.env };
    daemon = startDaemon(env);
    const placed = { ...process.env };
    expect(() =>
      startDaemon({ ...env, XDG_STATE_HOME: path.join(projectDir, "other") }),
    ).toThrow("this worker's env is held by a daemon that has not stopped");
    expect({ ...process.env }).toEqual(placed);

    const second = startDaemon(env);
    await daemon.stop();
    await daemon.stop();
    expect(process.env.XDG_STATE_HOME).toBe(env.XDG_STATE_HOME);
    await second.stop();
    expect({ ...process.env }).toEqual(before);
  });

  test("a TIMEOUT is the helper's to ask again", async () => {
    daemon = startDaemon(env);
    const { send, log, now } = daemon;
    let asked = 0;
    const out = await frameRequest(
      {
        log,
        now,
        send: (req, budgetMs) =>
          ++asked === 1
            ? Promise.resolve({
                ok: false,
                error: "slow",
                code: "TIMEOUT",
                request: 1 as RequestId,
              })
            : send(req, budgetMs),
      },
      renderBody("in-worker-timeout", projectDir),
    );
    expect(textOf(out)).toContain("[wide]");
    expect(asked).toBeGreaterThan(1);
  });

  test("a named copy uses its drawing session and an earlier desktop link keeps fallback", async () => {
    const session = "desktop-worktree";
    const bundle = path.join(projectDir, "worktree.mjs");
    writeFileSync(bundle, "// in-process fixture bundle");
    writeFileSync(userConfig, `{
      actions: { readout: { copy: "drawn clipboard contents" } },
      segments: { readout: { template: '{{ action "readout" "copy" }}' } },
      root: { h: ["readout"] },
    }`);
    let fake: FakeLauncher | undefined;
    daemon = startDaemon(env, {
      host: hostOf({ ...env, CANDYBAR_DESKTOP_PROOF: "daemon" }),
      launcher: (own) => {
        const fixture = fakeLauncher(systemTimekeeper, own);
        fixture.spawner.program((bin) => bin === "/usr/bin/pbcopy", exits());
        fixture.spawner.program((bin) => bin === "/usr/bin/open", exits());
        fake = fixture;
        return fixture.launcher;
      },
    });
    const frame = await frameRequest(daemon, {
      ...renderBody(session, projectDir, {}, ["cc-candybar", "--config", userConfig]),
      env: {
        ...TEST_ENV,
        CC_CANDYBAR_NAME: "worktree",
        CANDYBAR_DESKTOP_PROOF: "session",
      },
      client: { kind: "node", bundle, source: null },
    });
    const copy = findUrl(linkUrls(frame), (effects) =>
      effects.some(({ verb }) => verb === VERB_COPY),
    );
    if (copy === undefined) throw new Error("the named renderer drew no copy action");

    const otherCwd = path.join(projectDir, "primary");
    mkdirSync(otherCwd);
    await frameRequest(daemon, {
      ...renderBody("desktop-primary", otherCwd, {}, ["cc-candybar", "--config", userConfig]),
      env: { ...TEST_ENV, CANDYBAR_DESKTOP_PROOF: "other-session" },
    });
    await click(daemon, copy);

    const legacy = drawnLink(daemon, effectsUrl([
      { verb: VERB_OPEN_VSCODE, args: ["legacy-target"] },
    ]));
    await click(daemon, legacy);

    const desktop = fake?.started().filter(
      ({ bin }) => bin === "/usr/bin/pbcopy" || bin === "/usr/bin/open",
    );
    expect(desktop?.map(({ bin, options }) => ({
      bin,
      cwd: options.cwd,
      marker: options.env?.CANDYBAR_DESKTOP_PROOF,
    }))).toEqual([
      { bin: "/usr/bin/pbcopy", cwd: projectDir, marker: "session" },
      { bin: "/usr/bin/open", cwd: undefined, marker: "daemon" },
    ]);
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
    expect(daemon.log).toBe(logPath(hostOf(env)));
    await render(daemon, sid, projectDir);

    const subscriber = daemon.connect();
    const frames: Response[] = [];
    let closed = false;
    subscriber.on(
      "data",
      makeFrameReader(
        (frame) => {
          frames.push(frame as Response);
          return "more";
        },
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

    // Logged through the daemon's own log.
    const last = "the last line before the stop";
    daemon.daemon.log("info", last);
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
