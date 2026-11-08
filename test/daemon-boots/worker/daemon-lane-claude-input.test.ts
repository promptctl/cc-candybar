// [LAW:one-source-of-truth] A daemon types into Claude Code through the one
// claude-input edge it is built with: a lane's setup reaches the same edge a
// click does, so a daemon built over a stand-in edge types nothing into Claude
// Code for real. A restart's line into the pane's shell, once Claude Code has
// exited, goes through the lane edge, not this one.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { effectsUrl, VERB_SET_STATE } from "../../../src/click/wire";
import type { ClaudeInputEdge } from "../../../src/claude-input/edge";
import { LANES } from "../../../src/config/lanes";
import type { ClientHints } from "../../../src/daemon/protocol";
import { CLAUDE_START, claudeHolds } from "../../helpers/claude-record";
import { click, render } from "../../helpers/daemon-e2e";
import { logLines } from "../../helpers/daemon-log";
import { startDaemon, type InWorkerDaemon } from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { until } from "../../helpers/until";
import { bundleAt } from "../../helpers/worker-edges";

jest.setTimeout(30_000);

// A Claude Code prompt with nothing in it: the screen a slash command is
// typed into.
const READY_SCREEN = ["─".repeat(30), "❯ ", "─".repeat(30)];

describe("a daemon built over a claude-input edge", () => {
  let root: string;
  let removeTmpDirs: () => void;
  let env: NodeJS.ProcessEnv;
  let daemon: InWorkerDaemon;
  const typed: string[] = [];

  beforeAll(() => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-lane-input");
    ({ removeTmpDirs } = prepared);
    root = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-lane-input-"));
    writeFileSync(
      path.join(root, "lanes.json5"),
      `{ segments: { mark: { template: 'a lane mark' } }, root: { h: ['mark'] } }`,
    );
    // A source checkout with the band mod's client built, which the band
    // lane installs from.
    const checkout = path.join(root, "checkout");
    mkdirSync(path.join(checkout, "src"), { recursive: true });
    mkdirSync(path.join(checkout, "bin"));
    writeFileSync(path.join(checkout, "bin", "cc-candybar-native"), "");
    // First on the daemon's PATH: a tmux whose server shows pane %7, and a
    // `claude` CLI whose plugin installs succeed.
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "tmux"),
      `#!/bin/sh\ncase "$*" in *list-panes*) printf '%%7 $1 1 1 0 1\\n' ;; *) printf '' ;; esac\n`,
    );
    writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, "tmux"), 0o755);
    chmodSync(path.join(bin, "claude"), 0o755);
    env = { ...prepared.env, PATH: `${bin}:${prepared.env.PATH ?? ""}` };
    const claudeInput: ClaudeInputEdge = {
      read: async () => ({ inMode: false, screen: READY_SCREEN }),
      type: async (hint, line) => {
        typed.push(`${hint.pane} ${line}`);
        return { kind: "typed" };
      },
    };
    daemon = startDaemon(env, {
      bundle: bundleAt(checkout),
      claudeInput: () => claudeInput,
    });
  });

  afterAll(async () => {
    await daemon?.stop();
    rmSync(root, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("a lane's setup types into Claude Code through that edge", async () => {
    const sid = "lane-input";
    const claudeConfigDir = path.join(root, ".claude");
    claudeHolds(claudeConfigDir, 4000, sid);
    const hints: ClientHints = {
      tmux: { socket: `/tmp/lane-input-${sid}`, pane: "%7", truecolor: null },
      parent: { pid: 4000, startTime: CLAUDE_START },
      claudeConfigDir,
    };
    await render(daemon, sid, root, hints, [
      "cc-candybar",
      "--config",
      path.join(root, "lanes.json5"),
    ]);
    const { setting, on } = LANES.band.switch;
    await click(
      daemon,
      effectsUrl(daemon.name, [
        { verb: VERB_SET_STATE, args: [sid, setting, String(on)] },
      ]),
    );
    const laneLines = (): string[] =>
      logLines(env).filter(
        (l) => l.includes(" lane: band ") && l.includes(`(session=${sid})`),
      );
    await until(
      () => laneLines().some((l) => l.includes("typed /reload-plugins into %7")),
      () =>
        `the band's setup typing /reload-plugins (lane lines: ${JSON.stringify(laneLines())})`,
    );
    expect(typed).toEqual(["%7 /reload-plugins"]);
  });
});
