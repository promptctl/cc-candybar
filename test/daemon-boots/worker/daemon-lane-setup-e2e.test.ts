import { textOf, type Frame } from "../../../src/render/frame";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  existsSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  effectsUrl,
  VERB_SET_STATE,
} from "../../../src/click/wire";
import { LANES, type Lane } from "../../../src/config/lanes";
import { GLOBAL_FIELDS } from "../../../src/config/globals-fields";
import type { ClientHints } from "../../../src/daemon/foundations/protocol";
import {
  click,
  render,
  drawnLink,
} from "../../helpers/daemon-e2e";
import { logLines, renderLines } from "../../helpers/daemon-log";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { untilHeard } from "../../helpers/reload-signal";
import { writeAtomic } from "../../../src/utils/atomic-write";
import { valueOf } from "../../../src/utils/logfmt";
import { until } from "../../helpers/until";

jest.setTimeout(30_000);

// Every lane off: each test's own clicks switch them.
const CONFIG = `{ segments: { mark: { template: 'a lane mark' } }, root: { h: ['mark'] } }`;

describe("tmux panes follow effective display settings", () => {
  let removeTmpDirs: () => void;
  let env: NodeJS.ProcessEnv;
  let projectDir: string;
  let daemon: InWorkerDaemon;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-lane-e2e");
    ({ removeTmpDirs } = prepared);
    projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-lane-e2e-"));
    writeFileSync(path.join(projectDir, "lanes.json5"), CONFIG);
    const bin = path.join(projectDir, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "tmux"),
      `#!/bin/sh
held="$CANDYBAR_TEST_TMUX_STATE/${"$"}{2##*/}.split"
case "$*" in
  *list-panes*'pane_start_command'*)
    if [ -f "$held" ]; then printf '%%9 cc-candybar bar-pane %%7\n'; fi
    ;;
  *list-panes*) printf '%%7 $1 1 1 0 1\n' ;;
  *split-window*)
    if [ -f "$held.fail" ]; then
      rm "$held.fail"
      printf 'temporary split failure\n' >&2
      exit 1
    fi
    touch "$held"
    printf '%%9\n'
    ;;
  *kill-pane*'-t %9') rm -f "$held" ;;
esac
`,
    );
    chmodSync(path.join(bin, "tmux"), 0o755);
    env = {
      ...prepared.env,
      PATH: `${bin}:${prepared.env.PATH ?? ""}`,
      CANDYBAR_TEST_TMUX_STATE: projectDir,
    };
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
  // takes its pane.
  const inTmux = (sid: string): ClientHints => ({
    tmux: { socket: `/tmp/lane-e2e-${sid}`, pane: "%7", truecolor: null },
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
  test("an enabled tmux pane opens from config on the first render", async () => {
    const sid = "lane-pane-config";
    const file = path.join(projectDir, "pane.json5");
    writeFileSync(file, "{ globals: { experimentalPane: true } }");
    await render(daemon, sid, projectDir, inTmux(sid), [
      "cc-candybar",
      "--config",
      file,
    ]);
    const opened = (): string[] =>
      logLines(env).filter((line) =>
        line.includes(`bar-pane sid=${JSON.stringify(sid)} pane="%7" desired=on — opened bar pane %9`),
      );
    await until(
      () => opened().length > 0,
      () => `the configured bar pane (${logLines(env).filter((line) => line.includes("bar-pane")).join("; ")})`,
    );
    await render(daemon, sid, projectDir, inTmux(sid), [
      "cc-candybar",
      "--config",
      file,
    ]);
    expect(opened()).toHaveLength(1);
    await render(daemon, "lane-pane-next", projectDir, inTmux(sid), args());
    await until(
      () => logLines(env).some((line) =>
        line.includes(
          'bar-pane sid="lane-pane-next" pane="%7" desired=off — closed bar pane %9',
        ),
      ),
      "the next session's disabled bar pane setting",
    );
  });

  test("a first off declaration closes a split left by a previous host", async () => {
    const sid = "lane-pane-previous";
    const held = path.join(projectDir, `lane-e2e-${sid}.split`);
    writeFileSync(held, "");
    await renderIn(sid);
    await until(() => !existsSync(held), "the previous host's split to close");
  });

  test("an enabled pane retries a temporary split failure", async () => {
    const sid = "lane-pane-retry";
    const held = path.join(projectDir, `lane-e2e-${sid}.split`);
    writeFileSync(`${held}.fail`, "");
    await renderIn(sid);
    await switchLanes(sid, true, "pane");
    await until(
      () => logLines(env).some((line) => line.includes("temporary split failure")),
      "the first split to fail",
    );
    await until(async () => {
      await renderIn(sid);
      return existsSync(held);
    }, "the configured pane to open on retry");
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
        expect(new Set(reloads)).toEqual(new Set(["config"]));
      }
      expect(
        logLines(env).filter((l) => l.includes("config discovery why=landed")),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
