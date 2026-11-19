// [LAW:verifiable-goals] The daemon as a value, in this jest worker with no
// process of its own: built from its inputs, driven by the request handling
// the socket uses, closed with nothing left running, and built again over the
// same storage to see a restart.

import { linkKeyFile, linkKeyFromFile } from "../../../src/daemon/link-key";
import { linkSignerOver } from "../../../src/click/link-signer";
import { hostOf } from "../../helpers/host";
import type { Host } from "../../../src/host";
import type { ClaudeInputEdge } from "../../../src/claude-input/typing";
import { createHook } from "node:async_hooks";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { effectsUrl, VERB_SET_STATE, VERB_SLASH } from "../../../src/click/wire";
import type { RenderOrigin } from "../../../src/config-hint";
import { LANES } from "../../../src/config/lanes";
import type { ServedDaemon } from "../../../src/daemon/daemon";
import { inProcessRenderer } from "../../../src/in-process-renderer";
import {
  processPort,
  type RendererPort,
} from "../../../src/daemon/renderer-process";
import {
  MAIN_RENDERER,
  rendererNameOf,
  type RendererName,
} from "../../../src/daemon/foundations/renderer-name";
import {
  rendererOf,
  type RendererBoot,
} from "../../../src/renderer-interface/interface";
import type { LaunchResult } from "../../../src/proc/launcher";
import { systemTimekeeper, type Timekeeper } from "../../../src/time";
import { processProbe } from "../../helpers/host";
import {
  daemonPaths,
  sessionStatePath,
  settingsHistoryPath,
} from "../../../src/daemon/paths";
import {
  classifyInbound,
  PROTOCOL_VERSION,
  type ReaderRenderRequest,
  type Response,
} from "../../../src/daemon/foundations/protocol";
import { parseFrame, textOf, type Frame } from "../../../src/render/frame";
import { PACKAGE_VERSION } from "../../../src/version";
import { clickBody, findUrl, hookData } from "../../helpers/daemon-e2e";
import { linkUrls } from "../../helpers/frame";
import {
  buildDaemon,
  bundleAt,
  prepareDaemon,
  statsOf,
} from "../../helpers/in-worker-daemon";
import type { DaemonLog } from "../../../src/daemon/log";
import { until } from "../../helpers/until";
import { sessionIdOf } from "../../../src/daemon/foundations/session-id";
import { plainEnvironment } from "../../../src/daemon/foundations/session-env";
import { heldClock } from "../../helpers/held-clock";

const VALUE_REFUSED = sessionIdOf("value-refused");
const VALUE_CLOSE = sessionIdOf("value-close");
const WORKTREE = rendererNameOf("worktree");

// The daemon and its process supervisor are real. The channel keeps one
// renderer boot waiting for the child, with end and crash under the test's clock.
function waitingRenderer(waitingFor: RendererName) {
  const launches: Array<(result: LaunchResult) => void> = [];
  const pushes: Array<[RendererName, string]> = [];
  const closed: RendererName[] = [];
  const supervised = processPort({
    cwd: "/",
    heapCapMb: 64,
    launcher: {
      launchChannel: () => {
        let end!: (result: LaunchResult) => void;
        const ended = new Promise<LaunchResult>((resolve) => {
          end = resolve;
        });
        launches.push(end);
        return {
          pid: 9001,
          write: () => {},
          end: () => end({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
          ended,
        };
      },
    },
  });
  const local = inProcessRenderer();
  const port: RendererPort = (prepared) => {
    const chosen = prepared.name === waitingFor ? supervised : local;
    return {
      start: (own) => {
        const link = chosen(prepared).start(own);
        return {
          ...link,
          renderer: rendererOf({
            event: (input) => link.renderer.answer(input),
            adapter: (input) => {
              pushes.push([prepared.name, input.push.kind]);
              return link.renderer.answer(input);
            },
          }),
          close: async () => {
            await link.close();
            closed.push(prepared.name);
          },
        };
      },
    };
  };
  return { port, launches, pushes, closed };
}

jest.setTimeout(30_000);

// What can outlive a close. Enabled before the file's first launch, so it sees
// the lifeline. `getActiveResourcesInfo` can't show this: it omits what is
// unref'd, which is nearly every timer the daemon holds.
const WATCHED = new Set([
  "Timeout",
  "FSEVENTWRAP",
  "FSEVENT",
  "PROCESSWRAP",
  "PIPEWRAP",
]);
const live = new Map<number, Error>();
// From a close's return on: `init` and `before` run as the timer is armed and
// as it fires, where `destroy` lands some turns later. Null until then.
let baseline = new Set<number>();
let afterClose: { armed: Error[]; fired: Error[] } | null = null;
const resources = createHook({
  init: (id, type) => {
    if (!WATCHED.has(type)) return;
    const origin = new Error(type);
    live.set(id, origin);
    if (type === "Timeout") afterClose?.armed.push(origin);
  },
  before: (id) => {
    const origin = live.get(id);
    if (origin?.message === "Timeout" && !baseline.has(id)) {
      afterClose?.fired.push(origin);
    }
  },
  destroy: (id) => {
    live.delete(id);
  },
});

describe("the daemon is a value", () => {
  let root: string;
  let projectDir: string;
  let config: string;
  let open: ServedDaemon | null = null;
  // Every log the case opened: a case that builds a second daemon ends both.
  const openLogs: DaemonLog[] = [];

  // The machine a case runs on, read when asked: the worker's environment as it
  // stands (a case may have put a stub on PATH), with its state under `root`.
  const hostNow = (): Host =>
    hostOf({ ...process.env, XDG_STATE_HOME: path.join(root, "state") });
  // A link as this test's daemon draws it: signed with the key in its state
  // directory.
  const drawnHere = (link: string): string =>
    linkSignerOver(
      linkKeyFromFile(linkKeyFile(daemonPaths(hostNow()).state)),
    ).signLink(link);

  const construct = (
    inputs: {
      clock?: Timekeeper;
      checkout?: string;
      digest?: string;
      profile?: () => never;
      renderer?: RendererPort;
      claudeInput?: () => ClaudeInputEdge;
    } = {},
  ): ServedDaemon => {
    const { profile } = inputs;
    const { daemon, daemonLog } = buildDaemon({
      host: hostNow(),
      paths: daemonPaths(hostNow()),
      bundle: bundleAt(
        inputs.checkout ?? path.join(root, "checkout"),
        inputs.digest,
      ),
      ...(inputs.clock && { clock: inputs.clock }),
      ...(profile && { profile }),
      ...(inputs.renderer && { renderer: inputs.renderer }),
      ...(inputs.claudeInput && { claudeInput: inputs.claudeInput }),
    });
    open = daemon;
    openLogs.push(daemonLog);
    return daemon;
  };

  const close = async (daemon: ServedDaemon): Promise<void> => {
    await (
      await daemon.close()
    ).settled;
    open = null;
  };

  const renderRequest = (
    sessionId: string,
    deadlineMs = 2_000,
  ): ReaderRenderRequest => ({
    v: PROTOCOL_VERSION,
    kind: "render",
    encoding: "frame",
    hookData: hookData(sessionId, projectDir),
    args: ["cc-candybar", "--config", config],
    cwd: projectDir,
    termCols: 200,
    termRows: 40,
    deadline: Date.now() + deadlineMs,
    // The environment it runs in now, as a client started by Claude Code
    // reports its own.
    env: plainEnvironment(process.env),
  });

  const worktreeRequest = (session: string): ReaderRenderRequest => ({
    ...renderRequest(session),
    env: plainEnvironment({ ...process.env, CC_CANDYBAR_NAME: WORKTREE }),
    client: {
      kind: "node",
      bundle: path.join(root, "checkout", "dist", "index.mjs"),
      source: null,
    },
  });

  const reply = async (
    daemon: ServedDaemon,
    req: Parameters<ServedDaemon["reply"]>[0],
  ): Promise<Response> => {
    const handled = await daemon.handle(
      classifyInbound(req),
      () => false,
      daemon.stats.accept(),
      () => false,
    );
    if (handled.kind !== "reply") throw new Error("expected a reply");
    handled.settled(true);
    if (!handled.resp.ok) throw new Error(handled.resp.error);
    return handled.resp;
  };

  // A render's answer.
  const answer = async (
    daemon: ServedDaemon,
    req: ReaderRenderRequest,
  ): Promise<Frame> => {
    const resp = await reply(daemon, req);
    if (!("frame" in resp))
      throw new Error(`a render answered no frame: ${JSON.stringify(resp)}`);
    return parseFrame(resp.frame);
  };

  const clickLink = (daemon: ServedDaemon, url: string): Promise<Response> =>
    reply(daemon, clickBody(url));

  const writeConfig = (text: string): void => writeFileSync(config, text);

  test("the daemon boots a renderer with resolved locations and no environment map", async () => {
    const host = hostOf(
      {
        XDG_CONFIG_HOME: path.join(root, "chosen-config"),
        XDG_DATA_HOME: path.join(root, "chosen-data"),
        XDG_DATA_DIRS: [
          path.join(root, "site-one"),
          path.join(root, "site-two"),
        ].join(":"),
        XDG_STATE_HOME: path.join(root, "state"),
        CANDYBAR_FIXTURE_PRIVATE: "boot-marker",
      },
      { home: root },
    );
    const boots: RendererBoot[] = [];
    const local = inProcessRenderer();
    const built = buildDaemon({
      host,
      paths: daemonPaths(host),
      renderer: (prepared) =>
        local({
          ...prepared,
          boot: () => {
            const boot = prepared.boot();
            boots.push(boot);
            return boot;
          },
        }),
    });
    open = built.daemon;
    openLogs.push(built.daemonLog);
    expect(boots.map((boot) => Object.keys(boot).sort())).toEqual([
      ["locations", "memoryLimitBytes", "stored"],
    ]);
    expect(boots).toMatchObject([
      {
        locations: {
          home: root,
          configHome: path.join(root, "chosen-config"),
          dataHome: path.join(root, "chosen-data"),
          dataDirs: [path.join(root, "site-one"), path.join(root, "site-two")],
        },
      },
    ]);
    expect(JSON.stringify(boots)).not.toContain("boot-marker");
  });

  beforeAll(() => {
    resources.enable();
    root = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-value-"));
    // A source checkout: what the band's setup needs of the bundle it runs.
    const checkout = path.join(root, "checkout");
    mkdirSync(path.join(checkout, "dist"), { recursive: true });
    mkdirSync(path.join(checkout, "src"));
    mkdirSync(path.join(checkout, "bin"));
    writeFileSync(path.join(checkout, "dist", "index.mjs"), "");
    writeFileSync(path.join(checkout, "bin", "cc-candybar-native"), "");
    projectDir = path.join(root, "project");
    mkdirSync(projectDir);
    config = path.join(projectDir, "bar.json5");
  });

  afterEach(async () => {
    if (open !== null) await close(open);
    for (const log of openLogs.splice(0)) {
      await log.drained();
      log.dispose();
    }
    // A live scope would refuse the next test's daemon; this file runs one at a
    // time, so what is left here is the case's own.
    rmSync(sessionStatePath(hostNow()), { force: true });
    rmSync(settingsHistoryPath(hostNow()), { force: true });
  });

  afterAll(() => {
    resources.disable();
    rmSync(root, { recursive: true, force: true });
  });

  const PADDED = `{
    actions: { wide: { set: "padding", to: "4" } },
    segments: {
      pad: { template: '{{ action "wide" "[wide]" }}', bg: "surface", fg: "foreground" },
    },
    root: { h: ["pad"] },
  }`;
  const width = (bar: Frame): number => textOf(bar).trimEnd().length;

  test("only serving opens ingress, and a prepared daemon can close before it serves", async () => {
    const { daemon, daemonLog } = prepareDaemon({
      host: hostNow(),
      paths: daemonPaths(hostNow()),
    });
    openLogs.push(daemonLog);
    expect(daemon).not.toHaveProperty("handle");
    expect(daemon).not.toHaveProperty("reply");
    expect(daemon).not.toHaveProperty("subscribe");
    const closing = daemon.close();
    expect(daemon.close()).toBe(closing);
    expect(() => daemon.serve()).toThrow("the daemon closed");
    await expect((await closing).settled).resolves.toEqual({ unreaped: [] });
  });

  test("shutdown closes a primary still booting without requesting its journal or views", async () => {
    const renderer = waitingRenderer(MAIN_RENDERER);
    const daemon = construct({ renderer: renderer.port });
    daemon.arm();
    expect(renderer.launches).toHaveLength(1);

    await close(daemon);

    expect(renderer.pushes).toEqual([]);
    expect(renderer.closed).toEqual([MAIN_RENDERER]);
    await Promise.all(openLogs.map((log) => log.drained()));
    const log = readFileSync(daemonPaths(hostNow()).log, "utf8");
    expect(log).toContain("renderer main[1] exited in the daemon's close");
    expect(log).not.toMatch(
      /main close-(journal|views) failed|renderer main\[1\] start failed/,
    );
  });

  test("shutdown drains a live primary and cancels the restart of a down named renderer", async () => {
    writeConfig(PADDED);
    const clock = heldClock(new Date());
    const renderer = waitingRenderer(WORKTREE);
    const daemon = construct({ clock, renderer: renderer.port });
    daemon.arm();
    await answer(daemon, renderRequest("live-primary"));
    const requested = daemon.handle(
      classifyInbound(worktreeRequest("down-worktree")),
      () => false,
      daemon.stats.accept(),
      () => false,
    );
    expect(renderer.launches).toHaveLength(1);
    renderer.launches[0]!({
      ok: false,
      reason: "signal",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: "SIGTERM",
    });
    expect(await requested).toMatchObject({
      kind: "reply",
      resp: {
        ok: false,
        error: expect.stringContaining("renderer worktree is down"),
      },
    });

    await close(daemon);
    await clock.settle(60_000);

    expect(renderer.pushes).toEqual([
      [MAIN_RENDERER, "close-journal"],
      [MAIN_RENDERER, "close-views"],
    ]);
    expect(renderer.closed).toEqual([MAIN_RENDERER, WORKTREE]);
    expect(renderer.launches).toHaveLength(1);
    await Promise.all(openLogs.map((log) => log.drained()));
    const log = readFileSync(daemonPaths(hostNow()).log, "utf8");
    expect(log).not.toMatch(/worktree close-(journal|views) failed/);
  });

  test("the drain refuses pending work while another renderer flushes its journal", async () => {
    const pause = () => {
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        reached,
        release,
        wait: () => {
          entered();
          return released;
        },
      };
    };
    const context = pause();
    const journal = pause();
    const firstAct = pause();
    let paneReads = 0;
    const linesTyped: string[] = [];
    const session = "render-during-drain";
    const local = inProcessRenderer();
    const port: RendererPort = (prepared) => ({
      start: (own) => {
        const link = local(prepared).start(own);
        return {
          ...link,
          renderer: rendererOf({
            event: async (input) => {
              if (
                input.event.kind === "context" &&
                input.event.context.hookData.session_id === session
              )
                await context.wait();
              return link.renderer.answer(input);
            },
            adapter: async (input) => {
              if (
                prepared.name === WORKTREE &&
                input.push.kind === "close-journal"
              )
                await journal.wait();
              return link.renderer.answer(input);
            },
          }),
        };
      },
    });
    writeConfig(`{
      actions: { compact: { slash: '/compact' }, clear: { slash: '/clear' } },
      segments: {
        commands: { template: '{{ action "compact" "compact" }} {{ action "clear" "clear" }}' },
      },
      root: { h: ['commands'] },
    }`);
    const daemon = construct({
      renderer: port,
      claudeInput: () => ({
        read: async () => {
          paneReads++;
          return {
            inMode: false,
            screen: ["─".repeat(30), "❯ ", "─".repeat(30)],
          };
        },
        type: async (_pane, line) => {
          linesTyped.push(line);
          if (line === "/compact") await firstAct.wait();
          return { kind: "typed" };
        },
      }),
    });
    await answer(daemon, worktreeRequest("worktree-drains"));
    const pane = await answer(daemon, {
      ...renderRequest("pane-during-drain"),
      tmux: {
        socket: path.join(root, "tmux.sock"),
        pane: "%7",
        truecolor: null,
      },
    });
    const slashLink = (line: string) =>
      findUrl(linkUrls(pane), (effects) =>
        effects.some(({ verb, args }) => verb === VERB_SLASH && args[1] === line),
      );
    const compact = slashLink("/compact");
    const clear = slashLink("/clear");
    if (compact === undefined || clear === undefined)
      throw new Error("the pane actions did not draw their links");
    const request = (req: ReaderRenderRequest | ReturnType<typeof clickBody>) =>
      daemon.handle(
        classifyInbound(req),
        () => false,
        daemon.stats.accept(),
        () => false,
      );
    try {
      const first = request(clickBody(compact));
      await Promise.race([
        firstAct.reached,
        first.then((reply) => {
          throw new Error(
            `the first click did not type: ${JSON.stringify(reply)}`,
          );
        }),
      ]);
      const second = request(clickBody(clear));
      // The context uses the same mailbox. Once it reaches the renderer,
      // the second click has already handed its act to the pane queue.
      const pending = request(renderRequest(session, 20_000));
      await context.reached;
      expect(linesTyped).toEqual(["/compact"]);
      void daemon.close();
      context.release();
      await journal.reached;
      const handled = await pending;
      if (handled.kind !== "reply") throw new Error("expected a render reply");
      handled.settled(true);
      expect(handled.resp).toMatchObject({
        ok: false,
        error: expect.stringContaining("the daemon closed"),
      });
      firstAct.release();
      for (const clicked of await Promise.all([first, second])) {
        if (clicked.kind !== "reply") throw new Error("expected a click reply");
        clicked.settled(true);
      }
      expect(paneReads).toBe(1);
      expect(linesTyped).toEqual(["/compact"]);
    } finally {
      firstAct.release();
      context.release();
      journal.release();
      await close(daemon);
    }
    await Promise.all(openLogs.map((log) => log.drained()));
    const log = readFileSync(daemonPaths(hostNow()).log, "utf8");
    expect(log).toMatch(
      /\[info\] render .*sid=render-during-drain .*outcome=closing/,
    );
    expect(log).toMatch(
      /\[info\] act kind=type-slash .*outcome=ok — \/compact: typed/,
    );
    expect(log).toMatch(
      /\[info\] act kind=type-slash .*outcome=closing — \/clear:/,
    );
  });

  test("closing refuses requests and subscriptions without throwing or writing a click", async () => {
    writeConfig(PADDED);
    const daemon = construct();
    await answer(daemon, renderRequest("value-refused"));
    const click = clickBody(drawnHere(effectsUrl([
      { verb: VERB_SET_STATE, args: ["value-refused", "a.key", "on"] },
    ])));
    const closing = daemon.close();
    expect(daemon.close()).toBe(closing);
    const accepted = daemon.stats.accept();
    const render = await daemon.handle(
      classifyInbound(renderRequest("value-refused")),
      () => false,
      accepted,
      () => false,
    );
    expect(render).toMatchObject({ kind: "reply", resp: {
      ok: false,
      error: "the daemon closed: render refused",
    } });
    const clicked = await daemon.reply(click, () => false, daemon.stats.accept(), () => false);
    expect(clicked.resp).toMatchObject({ ok: false, error: "the daemon closed: click refused" });
    const refused = jest.fn();
    const unsubscribe = daemon.subscribe(VALUE_REFUSED, {
      lane: "statusline",
      frame: () => {},
      refused,
      drawing: () => true,
    });
    unsubscribe();
    expect(refused).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({
      error: "the daemon closed: subscribe refused",
    }));
    expect(() => daemon.arm()).toThrow("the daemon closed");
    await close(daemon);
    expect(existsSync(settingsHistoryPath(hostNow()))).toBe(false);
    await Promise.all(openLogs.map((log) => log.drained()));
    const lines = readFileSync(daemonPaths(hostNow()).log, "utf8").split("\n");
    const event = lines.filter((line) => line.includes(` render req=${accepted.id} `));
    expect(event).toHaveLength(1);
    expect(event[0]).toContain("[info]");
    expect(event[0]).toContain(" outcome=closing ");
  });

  // [LAW:no-shared-mutable-globals] What a daemon's loads accept is its own
  // value, so a second daemon built beside a live one is a daemon like any other.
  test("a second daemon beside a live one is built and answers", async () => {
    writeConfig(PADDED);
    const first = construct();
    const second = construct();
    expect(second).not.toBe(first);
    await answer(first, renderRequest("value-first"));
    await answer(second, renderRequest("value-second"));
    await close(first);
    await close(second);
  });

  test("a build that throws stands in the way of no next build", async () => {
    writeConfig(PADDED);
    const unreadable = (): never => {
      throw new Error("the profile cannot be opened");
    };
    const settled = [...live.keys()];
    expect(() => construct({ profile: unreadable })).toThrow(
      "the profile cannot be opened",
    );
    expect([...live.keys()].filter((id) => !settled.includes(id))).toEqual([]);

    const daemon = construct();
    await answer(daemon, renderRequest("value-rebuilt"));
    await close(daemon);
  });

  test("a render and a click go through the socket's own request handling", async () => {
    writeConfig(PADDED);
    const daemon = construct();

    const before = await answer(daemon, renderRequest("value-click"));
    expect(textOf(before)).toContain("[wide]");
    const [url] = linkUrls(before);
    await clickLink(daemon, url!);

    const after = await answer(daemon, renderRequest("value-click"));
    expect(width(after)).toBeGreaterThan(width(before));
  });

  test("a second daemon over the same storage sees the first's picks", async () => {
    writeConfig(PADDED);
    const first = construct();
    const before = await answer(first, renderRequest("value-restart"));
    const [url] = linkUrls(before);
    await clickLink(first, url!);
    await close(first);

    const second = construct();
    const after = await answer(second, renderRequest("value-restart"));
    expect(width(after)).toBeGreaterThan(width(before));
  });

  test("the bundle it is given is the build its stats name", async () => {
    const daemon = construct({ digest: "the-given-digest" });
    expect((await statsOf(daemon)).sourceDigest).toBe("the-given-digest");
    await close(daemon);
  });

  test("the clock it is given is the instant the bar is drawn at", async () => {
    writeConfig(
      `{ segments: { at: { template: 'EPOCH={{ unixEpoch now }}' } }, root: { h: ['at'] } }`,
    );
    const frozen = new Date("2031-02-03T04:05:06Z");
    const daemon = construct({
      clock: { ...systemTimekeeper, now: () => frozen.getTime() },
    });

    const bar = await answer(daemon, renderRequest("value-clock"));
    expect(textOf(bar)).toContain(`EPOCH=${frozen.getTime() / 1000}`);
  });

  test("close ends everything running: an armed daemon, a feed, a render mid-wait and a child in flight", async () => {
    const pidFile = path.join(root, "child.pid");
    rmSync(pidFile, { force: true });
    const ran = path.join(root, "shell-ran");
    rmSync(ran, { force: true });
    writeConfig(`{
      variables: {
        slow: { kind: 'shell', command: 'touch ${ran}; exec sleep 30', parse: { json: true }, cache: { never: true } },
      },
      segments: { mark: { template: 'mark {{ .slow }}' } },
      root: { h: ['mark'] },
    }`);

    const settled = [...live.keys()];
    baseline = new Set(settled);
    const daemon = construct();
    daemon.arm();

    // A recorded session and a source waiting in the background.
    await answer(daemon, renderRequest("value-close", 1));
    const { setting, on } = LANES.statusline.switch;
    await clickLink(
      daemon,
      drawnHere(
        effectsUrl([
          {
            verb: VERB_SET_STATE,
            args: ["value-close", setting, String(on)],
          },
        ]),
      ),
    );
    // A feed on the lane the click turned on: a refused subscription is no
    // feed, and would leave nothing here for the close to end.
    const refused = jest.fn();
    daemon.subscribe(VALUE_CLOSE, {
      lane: "statusline",
      frame: () => {},
      refused,
      drawing: () => true,
    });
    expect(refused).not.toHaveBeenCalled();
    // The launcher has an independent, long-lived child to reap.
    const child = daemon.launcher.launch({
      bin: "/bin/sh",
      args: ["-c", 'echo $$ > "$1"; exec sleep 30', "sh", pidFile],
      category: "user-shell",
    });
    // The shell opens the file before echo writes the PID. An empty file
    // would produce pid 0, which probes the worker's own process group.
    let childPid = 0;
    await until(() => {
      if (!existsSync(pidFile)) return false;
      const line = readFileSync(pidFile, "utf8");
      if (!/^[1-9]\d*\n$/.test(line)) return false;
      childPid = Number(line);
      return Number.isSafeInteger(childPid);
    }, "the child to record its pid");
    expect(processProbe.alive(childPid)).toBe(true);

    // A render waiting on the slow source as the daemon closes.
    await until(() => existsSync(ran), "the slow source running");
    const midWait = daemon.handle(
      classifyInbound(renderRequest("value-close", 20_000)),
      () => false,
      daemon.stats.accept(),
      () => false,
    );

    const sessionFile = sessionStatePath(hostNow());
    const { settled: closing } = await daemon.close();
    open = null;
    afterClose = { armed: [], fired: [] };
    const closedWith = readFileSync(sessionFile, "utf8");
    // The click's write, still inside its debounce, is on disk once the close
    // has resolved.
    expect(JSON.parse(closedWith)["value-close"]).toMatchObject({
      [setting]: String(on),
    });

    expect(await closing).toEqual({ unreaped: [] });
    expect(await child).toMatchObject({ ok: false, reason: "aborted" });
    expect(processProbe.alive(childPid)).toBe(false);
    await midWait;

    // Turns, not timers: a wait of this test's own would be in the record.
    const leftover = () =>
      [...live].filter(([id]) => !settled.includes(id)).map(([, held]) => held);
    const quietBy = Date.now() + 5_000;
    while (leftover().length > 0 && Date.now() < quietBy) {
      await new Promise((turn) => setImmediate(turn));
    }
    const { armed, fired } = afterClose;
    afterClose = null;
    const origins = (held: Error[]) => held.map(({ stack }) => stack);
    expect(origins(leftover())).toEqual([]);
    expect(origins(armed)).toEqual([]);
    // A launch's SIGKILL escalation is the one timer a close means to leave
    // armed: on a slow turn it fires before the child's end clears it.
    expect(
      origins(fired.filter(({ stack }) => !stack?.includes("at terminate ("))),
    ).toEqual([]);
    expect(readFileSync(sessionFile, "utf8")).toBe(closedWith);
    // Late work that would start a child finds its launcher closed.
    expect(
      await daemon.launcher.launch({
        bin: "/bin/echo",
        category: "user-shell",
      }),
    ).toMatchObject({ ok: false, reason: "aborted" });
  });
});
