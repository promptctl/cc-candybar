// [LAW:verifiable-goals] The daemon as a value, in this jest worker with no
// process of its own: built from its inputs, driven by the request handling
// the socket uses, closed with nothing left running, and built again over the
// same storage to see a restart.

import { createHook } from "node:async_hooks";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import type { RenderOrigin } from "../src/config-hint";
import { LANES } from "../src/config/lanes";
import {
  SYSTEM_CLOCK,
  type Daemon,
  type DaemonClock,
} from "../src/daemon/daemon";
import { pidAlive } from "../src/daemon/parent-watchdog";
import { sessionStatePath, settingsHistoryPath } from "../src/daemon/paths";
import { PROTOCOL_VERSION, type RenderRequest } from "../src/daemon/protocol";
import type { SessionStorage } from "../src/daemon/session-state";
import { parseHandlerUrl } from "../src/install/index";
import { PACKAGE_VERSION } from "../src/version";
import { hookData, linkUrls, stripAnsi } from "./helpers/daemon-e2e";
import { buildDaemon, bundleAt, statsOf } from "./helpers/in-worker-daemon";
import { until } from "./helpers/until";

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
  let scratchPath: string | undefined;
  let open: Daemon | null = null;

  const construct = (
    inputs: {
      clock?: DaemonClock;
      checkout?: string;
      digest?: string;
      session?: SessionStorage;
    } = {},
  ): Daemon => {
    const { session } = inputs;
    const daemon = buildDaemon({
      bundle: bundleAt(
        inputs.checkout ?? path.join(root, "checkout"),
        inputs.digest,
      ),
      ...(inputs.clock && { clock: inputs.clock }),
      ...(session && { storage: () => ({ session }) }),
    });
    open = daemon;
    return daemon;
  };

  const close = async (daemon: Daemon): Promise<void> => {
    await daemon.close();
    open = null;
  };

  const renderRequest = (
    sessionId: string,
    deadlineMs = 2_000,
  ): RenderRequest => ({
    v: PROTOCOL_VERSION,
    kind: "render",
    hookData: hookData(sessionId, projectDir),
    args: ["cc-candybar", "--config", config],
    cwd: projectDir,
    termCols: 200,
    termRows: 40,
    deadline: Date.now() + deadlineMs,
  });

  const answer = async (
    daemon: Daemon,
    req: RenderRequest | Parameters<Daemon["reply"]>[0],
  ): Promise<string> => {
    const handled = await daemon.handle(
      req,
      () => false,
      daemon.clock.monotonic(),
    );
    if (handled.kind !== "reply") throw new Error("expected a reply");
    handled.delivered();
    if (!handled.resp.ok) throw new Error(handled.resp.error);
    return "output" in handled.resp ? handled.resp.output : "";
  };

  const clickLink = (daemon: Daemon, url: string): Promise<string> => {
    const { verb, value } = parseHandlerUrl(url);
    return answer(daemon, {
      v: PROTOCOL_VERSION,
      kind: "click",
      verb,
      value,
      clientVersion: PACKAGE_VERSION,
    });
  };

  const writeConfig = (text: string): void => writeFileSync(config, text);

  beforeAll(() => {
    resources.enable();
    root = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-value-"));
    process.env.XDG_STATE_HOME = path.join(root, "state");
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
    // A live scope would refuse the next test's daemon; this file runs one at a
    // time, so what is left here is the case's own.
    rmSync(sessionStatePath(), { force: true });
    rmSync(settingsHistoryPath(), { force: true });
    if (scratchPath !== undefined) process.env.PATH = scratchPath;
    scratchPath = undefined;
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
  const width = (bar: string): number => stripAnsi(bar).trimEnd().length;

  test("a closed daemon refuses what reaches it, and a click writes nothing", async () => {
    writeConfig(PADDED);
    const daemon = construct();
    await answer(daemon, renderRequest("value-refused"));
    await close(daemon);
    const closed = "the daemon closed";

    await expect(
      answer(daemon, renderRequest("value-refused")),
    ).rejects.toThrow(closed);
    await expect(
      clickLink(
        daemon,
        effectsUrl([
          { verb: VERB_SET_STATE, args: ["value-refused", "a.key", "on"] },
        ]),
      ),
    ).rejects.toThrow(closed);
    expect(existsSync(settingsHistoryPath())).toBe(false);
    const refused = jest.fn();
    expect(() =>
      daemon.subscribe("value-refused", {
        lane: "band",
        frame: () => {},
        refused,
        drawing: () => true,
      }),
    ).toThrow(closed);
    expect(() => daemon.arm()).toThrow(closed);
    expect(() => daemon.reloadConfig({} as RenderOrigin)).toThrow(closed);
  });

  test("a second daemon while one is live is refused before it builds anything", async () => {
    writeConfig(PADDED);
    const daemon = construct();
    const load = jest.fn(() => ({}));
    expect(() =>
      construct({ session: { load, save: () => {}, flush: () => {} } }),
    ).toThrow("a daemon is already live");
    expect(load).not.toHaveBeenCalled();
    await close(daemon);
  });

  test("a build that throws stands in the way of no next build", async () => {
    writeConfig(PADDED);
    const unreadable: SessionStorage = {
      load: () => {
        throw new Error("the session file cannot be read");
      },
      save: () => {},
      flush: () => {},
    };
    const settled = [...live.keys()];
    expect(() => construct({ session: unreadable })).toThrow(
      "the session file cannot be read",
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
    expect(stripAnsi(before)).toContain("[wide]");
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
      clock: { ...SYSTEM_CLOCK, date: () => frozen },
    });

    const bar = await answer(daemon, renderRequest("value-clock"));
    expect(stripAnsi(bar)).toContain(`EPOCH=${frozen.getTime() / 1000}`);
  });

  test("close ends everything running: an armed daemon, a feed, a render mid-wait and a child in flight", async () => {
    // A `claude` first on PATH that says it started and blocks: the band's
    // setup launches it with no signal of its own, so only the daemon's close
    // can end it.
    const bin = path.join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const pidFile = path.join(root, "claude.pid");
    rmSync(pidFile, { force: true });
    writeFileSync(
      path.join(bin, "claude"),
      `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`,
    );
    chmodSync(path.join(bin, "claude"), 0o755);
    scratchPath = process.env.PATH;
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
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

    // The first render settles its wait early: a deadline in the past draws
    // the slow source as pending, and leaves the session's origin recorded.
    await answer(daemon, renderRequest("value-close", 1));
    const { setting, on } = LANES.band.switch;
    await clickLink(
      daemon,
      effectsUrl([
        {
          verb: VERB_SET_STATE,
          args: ["value-close", setting, String(on)],
        },
      ]),
    );
    // A feed on the lane the click turned on: a refused subscription is no
    // feed, and would leave nothing here for the close to end.
    const refused = jest.fn();
    daemon.subscribe("value-close", {
      lane: "band",
      frame: () => {},
      refused,
      drawing: () => true,
    });
    expect(refused).not.toHaveBeenCalled();
    await until(() => existsSync(pidFile), "the claude stub started");
    const claudePid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pidAlive(claudePid)).toBe(true);

    // A render waiting on the slow source as the daemon closes.
    await until(() => existsSync(ran), "the slow source running");
    const midWait = daemon.handle(
      renderRequest("value-close", 20_000),
      () => false,
      daemon.clock.monotonic(),
    );

    const sessionFile = sessionStatePath();
    const closing = await daemon.close();
    open = null;
    afterClose = { armed: [], fired: [] };
    const closedWith = readFileSync(sessionFile, "utf8");

    expect(await closing).toEqual({ unreaped: [] });
    expect(pidAlive(claudePid)).toBe(false);
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
