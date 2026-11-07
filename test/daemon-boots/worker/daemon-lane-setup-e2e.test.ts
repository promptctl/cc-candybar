import type { Frame } from "../../../src/render/frame";
// What a lane runs follows the session's own clicks, measured at the click,
// and the tmux status line follows a request's arrival and a click's commit:
// no draw — a request's or a frame's — starts either (src/daemon/lane-setup.ts,
// src/daemon/tmux-status.ts).

import { textOf } from "../../../src/render/frame";
import { linkUrls } from "../../helpers/frame";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  addressedLink,
  effectsUrl,
  VERB_SET_STATE,
  VERB_RANGE,
} from "../../../src/click/wire";
import { sendDaemonRequest } from "../../helpers/daemon-wire";
import { linkKeyFile, linkSignerFromKeyFile } from "../../../src/daemon/link-key";
import { LANES, type Lane } from "../../../src/config/lanes";
import { GLOBAL_FIELDS } from "../../../src/config/globals-fields";
import { PROTOCOL_VERSION, type ClientHints } from "../../../src/daemon/protocol";
import { claudeHolds } from "../../helpers/claude-record";
import { click, render, sendClick } from "../../helpers/daemon-e2e";
import { logLines, renderLines } from "../../helpers/daemon-log";
import { startDaemon, type InWorkerDaemon } from "../../helpers/in-worker-daemon";
import {
  prepareIsolatedDaemonEnv,
} from "../../helpers/spawn-isolated-daemon";
import { untilHeard } from "../../helpers/reload-signal";
import { writeAtomic } from "../../../src/utils/atomic-write";
import { valueOf } from "../../../src/utils/logfmt";
import { until } from "../../helpers/until";

jest.setTimeout(30_000);

// Every lane off: each test's own clicks switch them.
const CONFIG = `{ segments: { mark: { template: 'a lane mark' } }, root: { h: ['mark'] } }`;

describe("lane setups and the tmux status line follow events, never a draw", () => {
  let removeTmpDirs: () => void;
  let env: NodeJS.ProcessEnv;
  let projectDir: string;
  let otherDir: string;
  let daemon: InWorkerDaemon;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-lane-e2e");
    ({ removeTmpDirs } = prepared);
    projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-lane-e2e-"));
    otherDir = path.join(projectDir, "elsewhere");
    mkdirSync(otherDir);
    writeFileSync(path.join(projectDir, "lanes.json5"), CONFIG);
    // A tmux first on the daemon's PATH whose server shows pane %7, attached
    // and active, and answers anything else with nothing to say.
    const bin = path.join(projectDir, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "tmux"),
      `#!/bin/sh\ncase "$*" in *list-panes*) printf '%%7 $1 1 1 0 1\\n' ;; *) printf '' ;; esac\n`,
    );
    chmodSync(path.join(bin, "tmux"), 0o755);
    env = { ...prepared.env, PATH: `${bin}:${prepared.env.PATH ?? ""}` };
    daemon = startDaemon(env);
  });

  afterAll(async () => {
    await daemon?.stop();
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  const args = (): string[] => [
    "cc-candybar",
    "--config",
    path.join(projectDir, "lanes.json5"),
  ];
  // Each session in a tmux server of its own, so no other test's session
  // takes its pane, run by a Claude Code of its own that holds it.
  const claudes = new Map<string, number>();
  const inTmux = (sid: string): ClientHints => {
    const claudeConfigDir = path.join(projectDir, ".claude");
    const parentPid = claudes.get(sid) ?? 4000 + claudes.size;
    claudes.set(sid, parentPid);
    claudeHolds(claudeConfigDir, parentPid, sid);
    return {
      tmux: { socket: `/tmp/lane-e2e-${sid}`, pane: "%7", truecolor: null },
      parentPid,
      claudeConfigDir,
    };
  };
  const renderIn = (sid: string, dir = projectDir): Promise<Frame> =>
    render(daemon, sid, dir, inTmux(sid), args());
  // A lane's switch, moved: on is the value that turns it on, off the
  // setting's floor (`false` for a 🧪 toggle, `claude` for the renderer).
  const switchLanes = async (sid: string, on: boolean, ...lanes: Lane[]) =>
    await click(
      daemon,
      effectsUrl(
        daemon.name,
        lanes.map((lane) => {
          const { setting, on: value } = LANES[lane].switch;
          return {
            verb: VERB_SET_STATE,
            args: [
              sid,
              setting,
              on ? String(value) : String(GLOBAL_FIELDS[setting].floor),
            ],
          };
        }),
      ),
    );
  const laneLines = (sid: string): string[] =>
    logLines(env).filter(
      (l) => l.includes(" lane: ") && l.includes(`(session=${sid})`),
    );
  const statusLines = (sid: string, what: "holding" | "released"): string[] =>
    logLines(env).filter((l) =>
      l.includes(`tmux-status: ${what} sid=${JSON.stringify(sid)}`),
    );
  // A request whose render event is logged: everything its arrival started
  // has been logged before it. Counted by the renders its client kept, not by
  // every attempt it logged.
  const renderedAgain = async (
    sid: string,
    dir = projectDir,
  ): Promise<void> => {
    const before = (await renderLines(env, sid)).length;
    await renderIn(sid, dir);
    await renderLines(env, sid, before + 1);
  };

  test("a lane toggle with no request after it is set up once, in the turn after its click", async () => {
    const sid = "lane-click";
    await renderIn(sid);
    const events = (await renderLines(env, sid)).length;
    await switchLanes(sid, true, "tmuxStatus");
    await until(() => laneLines(sid).length > 0, "the toggle's setup");
    expect(laneLines(sid)).toEqual([
      expect.stringContaining(
        `lane: tmuxStatus on — the daemon draws %7's bar in its status line by=click (session=${sid})`,
      ),
    ]);
    // The click itself held the status line: no request came after it.
    await until(
      () => statusLines(sid, "holding").length > 0,
      "the status line's hold",
    );
    expect(await renderLines(env, sid)).toHaveLength(events);
    // A request after it, and one from another directory, set nothing up
    // again and keep the status line held.
    await renderedAgain(sid);
    await renderedAgain(sid, otherDir);
    expect(laneLines(sid)).toHaveLength(1);
    expect(statusLines(sid, "holding")).toHaveLength(1);
    expect(statusLines(sid, "released")).toEqual([]);
  });

  // [LAW:nothing-unseen] A status-line click's event names its own verb and
  // address, the link its range draws, and the address and verb that link
  // carries, as `linkTo` and `linkVerb`.
  test("a status-line click runs the link its range draws, and its click event names both verbs and both addresses", async () => {
    const sid = "lane-status-click";
    await renderIn(sid);
    await switchLanes(sid, true, "tmuxStatus");
    await until(
      () => statusLines(sid, "holding").length > 0,
      "the status line's hold",
    );
    const link = linkUrls(await renderIn(sid)).find((u) =>
      u.startsWith(`cc-candybar://to/${daemon.name}/dispatch/`),
    );
    expect(link).toBeDefined();
    // [LAW:one-source-of-truth] The range as a subscriber of the lane is sent
    // it: the encoding the status line drew, so a click on it reaching the
    // link shows the stream and tmux were given one set of ids.
    const streamed = (await sendDaemonRequest(
      daemon,
      { v: PROTOCOL_VERSION, kind: "subscribe", sessionId: sid, lane: "tmuxStatus" },
      5000,
    )) as { tmuxStatus: { links: Record<string, string> } };
    const range = Object.entries(streamed.tmuxStatus.links).find(
      ([, url]) => url === link,
    )?.[0];
    expect(range).toBeDefined();
    // The click as the daemon's binding on that server would make it, signed
    // with the home's link key.
    const socket = `/tmp/lane-e2e-${sid}`;
    const mac = linkSignerFromKeyFile(
      linkKeyFile(daemon.paths.state),
    ).signBinding(socket);
    const at = [socket, mac, "7", range!].map(encodeURIComponent).join("/");
    const statusClick = addressedLink(daemon.name, VERB_RANGE, at);
    // Refused until the status line has drawn its first frame, which runs
    // nothing; the first click it answers runs the link.
    let refusal = "";
    await until(
      async () => {
        const resp = await sendClick(daemon, statusClick);
        refusal = resp.ok ? "" : resp.error;
        return resp.ok;
      },
      () => `the status-line click's acceptance (refused: ${refusal})`,
    );
    const ran = (): string[] =>
      logLines(env).filter(
        (l) =>
          / \[info\] click /.test(l) &&
          l.includes(` verb=${VERB_RANGE} `),
      );
    await until(() => ran().length > 0, "the status-line click's event");
    const [event, ...more] = ran();
    expect(more).toEqual([]);
    expect(event).toContain(` link=${JSON.stringify(link)} `);
    // The binding's URL and the link its range marks both name this
    // renderer, under one key each, so neither reads as the other.
    expect(event).toContain(` to=${daemon.name} verb=${VERB_RANGE} `);
    expect(event).toContain(` linkTo=${daemon.name} linkVerb=dispatch sid=${sid} `);
    expect(event!.match(/ to=/g)).toHaveLength(1);
    expect(event).toContain(" outcome=ok");
  });

  test("one click of two lane toggles sets up both", async () => {
    const sid = "lane-two";
    await renderIn(sid);
    await switchLanes(sid, true, "tmuxStatus", "band");
    await until(() => laneLines(sid).length >= 2, "both toggles' setups");
    expect(
      laneLines(sid)
        .map((l) => l.match(/lane: (\w+ \w+)/)![1])
        .sort(),
    ).toEqual(["band on", "tmuxStatus on"]);
    for (const line of laneLines(sid)) expect(line).toContain(" by=click ");
  });

  test("a status line switched off is released once, and nothing re-takes it", async () => {
    const sid = "lane-off";
    await renderIn(sid);
    await switchLanes(sid, true, "tmuxStatus");
    await until(
      () => statusLines(sid, "holding").length > 0,
      "the status line's hold",
    );
    await switchLanes(sid, false, "tmuxStatus");
    await until(
      () => statusLines(sid, "released").length > 0,
      "the status line's release",
    );
    await renderedAgain(sid);
    expect(statusLines(sid, "holding")).toHaveLength(1);
    expect(statusLines(sid, "released")).toHaveLength(1);
  });

  // Taken by another session (a `/clear`: the pane's Claude Code now holds
  // it), the pane is released at the next answer from its server; the click
  // only remembers it. A client run in the pane under any session its Claude
  // Code does not hold (candybar-gather-renderer-76bb.1dh.aom) takes nothing
  // and releases nothing: the one release names the session that did take
  // it, and each render event says why it did or did not.
  test("a click that leaves the status line's switch alone re-takes no status line released since", async () => {
    const sid = "lane-taken";
    await renderIn(sid);
    await switchLanes(sid, true, "tmuxStatus");
    await until(
      () => statusLines(sid, "holding").length > 0,
      "the status line's hold",
    );
    const pane = inTmux(sid);
    const where = { socket: pane.tmux!.socket, pane: pane.tmux!.pane };
    const paneSession = () =>
      sendDaemonRequest(daemon, { v: PROTOCOL_VERSION, kind: "pane-session", ...where }, 5000);
    const paneFactOf = async (of: string): Promise<string> => {
      const [event] = await renderLines(env, of, 1);
      return / pane=("[^"]*"|\S+)/.exec(event!)?.[1] ?? "absent";
    };
    expect(await paneSession()).toEqual({ ok: true, paneSession: sid });
    expect(await paneFactOf(sid)).toBe("runs");
    // Run from the shell Claude Code's Bash tool opens, whose parent keeps
    // no record, and by Claude Code itself under a session it does not hold.
    const shell = 3999;
    await render(daemon, "lane-shell", projectDir, { ...pane, parentPid: shell }, args());
    await render(daemon, "lane-stranger", projectDir, pane, args());
    expect(await paneSession()).toEqual({ ok: true, paneSession: sid });
    expect(await paneFactOf("lane-shell")).toBe(
      valueOf(
        `unconfirmed: the process that ran its statusline (pid ${shell}) is no Claude Code whose session can be read: it keeps no session record at ${path.join(pane.claudeConfigDir!, "sessions", `${shell}.json`)} (update Claude Code with \`claude update\`: recent releases keep one). A statusline command that runs the client through a shell or a wrapper (a script, \`pnpm dlx\`) hands it that process instead: \`cc-candybar install\` writes one that runs it directly`,
      ),
    );
    expect(await paneFactOf("lane-stranger")).toBe(
      valueOf(
        `mismatched: the Claude Code that ran its statusline (pid ${pane.parentPid}) holds session ${sid}`,
      ),
    );
    // Run from that shell under the pane's own session, a client says
    // nothing of where the session runs: its hold stays, as the one release
    // below says.
    await render(daemon, sid, projectDir, { ...pane, parentPid: shell }, args());
    await render(daemon, sid, projectDir, pane, args());
    // The next session's first request can arrive before its Claude Code
    // rewrites the record (a `/clear`): the pane follows it once the record
    // names it, with no request since.
    await render(daemon, "lane-taker", projectDir, pane, args());
    expect(await paneSession()).toEqual({ ok: true, paneSession: sid });
    claudeHolds(pane.claudeConfigDir!, pane.parentPid!, "lane-taker");
    expect(await paneSession()).toEqual({ ok: true, paneSession: "lane-taker" });
    await until(
      () => statusLines(sid, "released").length > 0,
      "the taken pane's release",
    );
    expect(statusLines(sid, "released")).toEqual([
      expect.stringContaining(`pane taken by sid="lane-taker"`),
    ]);
    // The band's setup runs in the turn after its click: anything the click
    // held was logged before it.
    await switchLanes(sid, true, "band");
    await until(
      () => laneLines(sid).some((l) => l.includes("lane: band on")),
      "the band's setup",
    );
    expect(statusLines(sid, "holding")).toHaveLength(1);
  });

  // candybar-plugins-vf6g.qzx: the renderer is shared by every session the
  // config renders, and a session outside tmux has no status line to take.
  test("a session outside tmux under renderer tmux draws the whole bar in its statusline and leaves the setting as it is", async () => {
    const sid = "lane-no-tmux";
    const file = path.join(projectDir, "renderer-tmux.json5");
    const source = `{ globals: { renderer: "tmux" }, segments: { mark: { template: 'a lane mark' } }, root: { h: ['mark'] } }`;
    writeFileSync(file, source);
    const drawn = await render(daemon, sid, projectDir, {}, [
      "cc-candybar",
      "--config",
      file,
    ]);
    expect(textOf(drawn)).toContain("a lane mark");
    expect(textOf(drawn)).not.toContain("⟲ claude");
    await renderLines(env, sid, 1);
    expect(statusLines(sid, "holding")).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(source);
  });

  // The daemon before a restart drew the bar the toggle is clicked on: this
  // daemon holds no request of the session yet.
  test("a click before the session's first request owes its setup to that request", async () => {
    const sid = "lane-owed";
    await renderIn(sid);
    await daemon.stop();
    daemon = startDaemon(env);
    await switchLanes(sid, true, "tmuxStatus");
    await renderedAgain(sid);
    await until(() => laneLines(sid).length > 1, "the owed setup");
    // Owed at the click, which had no session to set up, and set up once, by
    // the request.
    expect(laneLines(sid)).toEqual([
      expect.stringContaining(`lane: owed tmuxStatus on (session=${sid})`),
      expect.stringContaining(" by=owed "),
    ]);
    expect(statusLines(sid, "holding")).toHaveLength(1);
  });

  // A click that writes no config file reloads no entry, however many
  // directories render that config. Judged by what each load says caused it,
  // on the event every load path emits. The directories are this test's own,
  // so every load of their entries is here: each opens once, and after that
  // only its config watch, hearing the config rewritten after the click,
  // loads it again. A load the click caused would say another cause; a write
  // of its own to the config would leave the file changed before the rewrite.
  test("a lane switch's click reloads no entry; the config's own rewrite reloads each one", async () => {
    const sid = "lane-no-reload";
    const root = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "cc-candybar-lane-reload-")),
    );
    try {
      const cfg = path.join(root, "reload.json5");
      writeFileSync(cfg, CONFIG);
      const dirs = ["a", "b", "c"].map((d) => path.join(root, d));
      for (const [i, d] of dirs.entries()) {
        mkdirSync(d);
        await render(daemon, `${sid}-${i}`, d, inTmux(`${sid}-${i}`), [
          "cc-candybar",
          "--config",
          cfg,
        ]);
      }
      const written = (): bigint => statSync(cfg, { bigint: true }).mtimeNs;
      const unwritten = written();
      await switchLanes(`${sid}-0`, true, "pane");
      await until(() => laneLines(`${sid}-0`).length > 0, "the pane's setup");
      const clicked = `set-state: ${LANES.pane.switch.setting}=true (session=${sid}-0)`;
      // The click's one file write, landed: a save after the click wrote a
      // snapshot taken after its pick.
      await until(() => {
        const lines = logLines(env);
        const at = lines.findIndex((l) => l.includes(clicked));
        return (
          at >= 0 &&
          lines.slice(at).some((l) => l.includes(" session-state saved "))
        );
      }, "the session-state save after the click");
      expect(written()).toBe(unwritten);
      const causes = (d: string): string[] =>
        logLines(env)
          .filter((l) =>
            l.includes(
              ` config loaded projectDir=${valueOf(d)} cwd=${valueOf(d)} `,
            ),
          )
          // A logfmt value: bare, or a JSON string.
          .map((l) => / cause=("(?:[^"\\]|\\.)*"|\S+) /.exec(l)![1]!);
      const rewrite = valueOf(`config-watch:${cfg}`);
      // The positive control: each entry draws the rewritten config, so its
      // watch delivered the rewrite, and an event the click caused would
      // have been delivered before it.
      const reloaded = CONFIG.replace("a lane mark", "a reloaded mark");
      await untilHeard(
        () => writeAtomic(cfg, reloaded),
        async () =>
          (
            await Promise.all(
              dirs.map((d, i) =>
                render(daemon, `${sid}-${i}`, d, inTmux(`${sid}-${i}`), [
                  "cc-candybar",
                  "--config",
                  cfg,
                ]),
              ),
            )
          ).every((drawn) => textOf(drawn).includes("a reloaded mark")),
        "each entry's draw of the rewritten config",
      );
      for (const d of dirs) {
        const [opened, ...reloads] = causes(d);
        expect(opened).toBe("open");
        expect(new Set(reloads)).toEqual(new Set([rewrite]));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
