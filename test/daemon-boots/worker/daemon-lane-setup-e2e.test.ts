import {hostOf} from "../../../scripts/lib/host";
import {stateDir} from "../../../src/daemon/paths";
import { decodeAnsi } from "@promptctl/rich-js";
import { textOf, type Frame } from "../../../src/render/frame";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { sessionIdOf } from "../../../src/daemon/foundations/session-id";
import path from "node:path";

import { effectsUrl, VERB_SET_STATE } from "../../../src/click/wire";
import {
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../../../src/config/loader/edit-mode";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../../../src/config/door";
import { sharedMenuStateKey } from "../../../src/config/menu-keys";
import { linksOf } from "../../../src/click/read";
import { LANE_NAMES, LANES, type Lane } from "../../../src/config/lanes";
import { GLOBAL_FIELDS } from "../../../src/config/globals-fields";
import {
  parseResponse,
  type ClientHints,
} from "../../../src/daemon/foundations/protocol";
import {
  click,
  render,
  drawnLink,
  linkTo,
  urlWriting,
} from "../../helpers/daemon-e2e";
import { logLines, renderLines } from "../../../scripts/lib/daemon/log";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { untilHeard } from "../../helpers/reload-signal";
import { writeAtomic } from "../../../src/utils/atomic-write";
import { valueOf } from "../../../src/utils/logfmt";
import { until } from "../../../scripts/lib/until";

jest.setTimeout(30_000);

// Every lane off: each test's own clicks switch them.
const CONFIG = `{ segments: { mark: { template: 'a lane mark' } }, root: { h: ['mark'] } }`;

describe("tmux panes follow effective display settings", () => {
  let removeTmpDirs: () => void;
  let env: NodeJS.ProcessEnv;
  let projectDir: string;
  let daemon: InWorkerDaemon;

  // Each server independently owns a terminal, the process record of the
  // Claude session there and any physical drawing pane. A packet can name
  // that source without belonging to its recorded session.
  interface Fixture {
    readonly socket: string;
    readonly serverPid: number;
    readonly root: number;
    session: string;
    instance: string | null;
    opened: number;
    text?: string;
    fail: boolean;
    snapshot?: (raw: string) => void;
    changed?: () => void;
  }
  const servers = new Map<string, Fixture>();
  function server(name: string): Fixture {
    const socket = `/tmp/lane-e2e-${name}`;
    let found = servers.get(socket);
    if (!found) {
      const id = 1000 + servers.size * 4;
      found = {
        socket,
        serverPid: id,
        root: id + 1,
        session: name,
        instance: null,
        opened: 0,
        fail: false,
      };
      servers.set(socket, found);
    }
    return found;
  }
  function publish(s: Fixture): void {
    const rows = [
      `B ${s.serverPid}`,
      `P %7 $0 1 1 0 1 1 ${s.root} /dev/pts/${s.root}`,
    ];
    if (s.instance)
      rows.push(`P %9 $0 1 1 0 0 1 ${s.root + 1} /dev/pts/${s.root + 1}`);
    s.snapshot?.([...rows, "C $0 0", `E ${s.serverPid}`].join("\n"));
  }
  function enroll(s: Fixture, instance: string): void {
    let leave: () => void = () => {};
    leave = daemon.daemon.enroll(
      {
        socket: s.socket,
        source: "%7",
        drawing: "%9",
        serverPid: s.serverPid,
        followerPid: s.root + 1,
        instance,
      },
      {
        update: (_placement, frame, done) => {
          if (frame) {
            const message = parseResponse(JSON.parse(frame));
            if (message.ok && "output" in message)
              s.text = decodeAnsi(message.output).plain;
          }
          done?.(true);
        },
        refused: () =>
          queueMicrotask(() => {
            leave();
            if (s.instance === instance) {
              s.instance = null;
              publish(s);
            }
          }),
        disconnect: () => queueMicrotask(() => leave()),
      },
    );
  }
  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-lane-e2e");
    ({ removeTmpDirs } = prepared);
    projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-lane-e2e-"));
    writeFileSync(path.join(projectDir, "lanes.json5"), CONFIG);
    env = prepared.env;
    daemon = startDaemon(env, {
      tmuxObserver: () => ({
        observe(socket, events) {
          const s = servers.get(socket)!;
          s.snapshot = events.snapshot;
          queueMicrotask(() => publish(s));
          return () => {
            if (s.snapshot === events.snapshot) delete s.snapshot;
          };
        },
      }),
      tmuxSourceEdges: () => ({
        async inspect(pane, claims, watch) {
          const s = [...servers.values()].find((s) => s.root === pane.pid)!;
          watch([s.socket]);
          const confirmed = claims.some(
            (c) =>
              c.sid === s.session &&
              (c.parentPid === undefined || c.parentPid === s.root),
          );
          return confirmed
            ? { kind: "confirmed", sid: sessionIdOf(s.session) }
            : {
                kind: "unknown",
                reason: "fixture Claude record holds another session",
              };
        },
        watch(socket, changed) {
          const s = servers.get(socket)!;
          s.changed = changed;
          return () => {
            if (s.changed === changed) delete s.changed;
          };
        },
      }),
      barPaneEdge: () => ({
        async find(source) {
          const instance = servers.get(source.socket)!.instance;
          return instance ? { drawing: "%9", instance } : null;
        },
        async open(source, _serverPid, _host, instance) {
          const s = servers.get(source.socket)!;
          if (s.fail) {
            s.fail = false;
            throw new Error("temporary split failure");
          }
          if (s.instance) throw new Error("duplicate split");
          s.instance = instance;
          s.opened++;
          publish(s);
          queueMicrotask(() => enroll(s, instance));
          return { drawing: "%9", instance };
        },
        async retire(source, _serverPid, _host, pane) {
          const s = servers.get(source.socket)!;
          if ("instance" in pane && s.instance === pane.instance) {
            s.instance = null;
            publish(s);
          }
        },
      }),
    });
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
  // takes its pane.
  const inTmux = (sid: string): ClientHints => ({
    tmux: { socket: server(sid).socket, pane: "%7", truecolor: null },
  });
  const renderIn = (sid: string, dir = projectDir): Promise<Frame> =>
    render(daemon, sid, dir, inTmux(sid), args());
  // A lane's switch, moved: on is the value that turns it on, off the
  // setting's floor (`false` for a 🧪 toggle, `claude` for the renderer).
  const switchLanes = async (sid: string, on: boolean, ...lanes: Lane[]) =>
    await click(
      daemon,
      drawnLink(
        daemon,
        effectsUrl(
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
      ),
    );
  test("renderer switches saved through the menu reach a fresh session on its first render", async () => {
    const sid = "lane-pane-config";
    const file = path.join(projectDir, "pane.json5");
    writeFileSync(file, CONFIG);
    const bar = (session: string) =>
      render(
        daemon,
        session,
        projectDir,
        session === sid ? inTmux(session) : { tmux: null },
        ["cc-candybar", "--config", file],
      );
    const follow = async (session: string, label: string) =>
      click(daemon, linkTo(await bar(session), label));
    const openRenderer = async (session: string) => {
      await click(
        daemon,
        urlWriting(await bar(session), SETTINGS_ANCHOR, SETTINGS_OPEN),
      );
      await click(
        daemon,
        urlWriting(await bar(session), "candybar.tab", "config"),
      );
      await click(
        daemon,
        urlWriting(
          await bar(session),
          sharedMenuStateKey("candybar.pickers"),
          "renderer",
        ),
      );
    };

    const editor = "lane-pane-editor";
    await openRenderer(editor);
    for (const lane of LANE_NAMES)
      await follow(editor, `☐ ${LANES[lane].label}`);
    expect(readFileSync(file, "utf8")).toBe(CONFIG);
    await follow(editor, `💾 save ${LANE_NAMES.length}`);

    await bar(sid);
    const source = server(sid);
    await until(
      () => source.opened === 1,
      "the saved switch to open its cold source on a legacy render",
    );
    // Inspect the saved controls in another fresh Claude session outside
    // tmux. The enrolled pane now owns the drawing surface at sid.
    const settingsReader = "fresh-settings-reader";
    await openRenderer(settingsReader);
    const fresh = textOf(await bar(settingsReader));
    for (const lane of LANE_NAMES) {
      expect(fresh).toContain(`☑ ${LANES[lane].label}`);
    }
    expect(fresh).not.toContain("💾 save");
    expect(source.opened).toBe(1);
    await render(daemon, "unrelated-tool", projectDir, inTmux(sid), args());
    expect(source.instance).not.toBeNull();
    source.session = "lane-pane-next";
    source.changed?.();
    await render(daemon, "lane-pane-next", projectDir, inTmux(sid), args());
    await until(
      () => source.instance === null,
      "the next session's disabled bar pane setting",
    );
  });

  test("a draft pane preference reaches the host only after Save", async () => {
    const sid = "lane-draft";
    const file = path.join(projectDir, "pane-draft.json5");
    const bar = () =>
      render(daemon, sid, projectDir, inTmux(sid), [
        "cc-candybar",
        "--config",
        file,
      ]);
    const held = server(sid);
    writeFileSync(file, CONFIG);
    await click(
      daemon,
      urlWriting(await bar(), SETTINGS_ANCHOR, SETTINGS_OPEN),
    );
    await click(
      daemon,
      urlWriting(await bar(), EDIT_MODE_KEY, EDIT_MODE_ARRANGE),
    );
    await switchLanes(sid, true, "pane");
    const draft = await bar();
    expect(readFileSync(file, "utf8")).toBe(CONFIG);
    expect(held.instance).toBeNull();

    const save = linksOf(draft).find((link) => link.text === "✓ save");
    expect(save).toBeDefined();
    await click(daemon, save!.url);
    await until(() => held.instance !== null, "the saved bar pane to open");
    expect(readFileSync(file, "utf8")).toContain("experimentalPane: true");
  });

  test("a first off declaration closes a split left by a previous host", async () => {
    const sid = "lane-pane-previous";
    const held = server(sid);
    held.instance = randomUUID();
    enroll(held, held.instance);
    await renderIn(sid);
    await until(
      () => held.instance === null,
      "the previous host's split to close",
    );
  });

  test("an enabled pane retries a temporary split failure", async () => {
    const sid = "lane-pane-retry";
    const held = server(sid);
    held.fail = true;
    await renderIn(sid);
    await switchLanes(sid, true, "pane");
    await until(
      () =>
        logLines(env).some((line) => line.includes("temporary split failure")),
      "the first split to fail",
    );
    await until(async () => {
      await renderIn(sid);
      return held.instance !== null;
    }, "the configured pane to open on retry");
  });

  test("an enabled session moves its bar to the newly reported pane at the same lane setting", async () => {
    const sid = "lane-pane-moved";
    const next = `${sid}-new`;
    const held = server(sid);
    const replacement = server(next);
    replacement.session = sid;
    await renderIn(sid);
    await switchLanes(sid, true, "pane");
    await until(() => held.instance !== null, "the original pane to open");

    await render(daemon, sid, projectDir, inTmux(next), args());
    await until(
      () => replacement.instance !== null && held.instance === null,
      "the replacement pane to open and the previous pane to close",
    );
  });

  // A click that writes no config file reloads no entry, however many
  // directories render that config. The directories are this test's own, so
  // every load of their entries is here: each opens once, and after that only
  // the config its origin's watch moved, hearing the config rewritten after
  // the click, loads it again. A click that landed a write would discover its
  // origins again for its landing; a write of its own to the config would
  // leave the file changed before the rewrite.
  test("a lane switch's click reloads no entry; the config's own rewrite reloads each one", async () => {
    const sid = "lane-no-reload";
    const landedDiscoveries = () =>
      logLines(env).filter((line) =>
        line.includes("config discovery why=landed"),
      );
    const before = landedDiscoveries();

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
      // A successful click has journaled the pick before replying.
      const journal = path.join(stateDir(hostOf(env)),"shared-session","changes");
      const changes = readFileSync(journal,"utf8").trimEnd().split("\n").flatMap(line=>JSON.parse(line.slice(65)).writes);
      expect(changes).toContainEqual(expect.objectContaining({
        kind:"patch",store:"session-state",key:`${sid}-0`,changes:expect.objectContaining({[LANES.pane.switch.setting]:"true"}),
      }));
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
          ).every(
            (drawn, i) =>
              textOf(drawn).includes("a reloaded mark") ||
              server(`${sid}-${i}`).text?.includes("a reloaded mark"),
          ),
        "each entry's draw of the rewritten config",
      );
      for (const d of dirs) {
        const [opened, ...reloads] = causes(d);
        expect(opened).toBe("open");
        expect(new Set(reloads)).toEqual(new Set(["config"]));
      }
      expect(landedDiscoveries()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
