// [LAW:no-shared-mutable-globals] A launch carries its owner, so a daemon built
// in a process where a closed one's work is still unwinding lends that work
// nothing: not a launch, not a rate limit, and not its log. Each case restarts a
// daemon in this worker with no wait between the close and the build, which is
// the order a real process can never reach.

import { NO_TMUX_AT_EXIT } from "./helpers/in-worker-daemon";
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

import { PROTOCOL_VERSION, type Request } from "../src/daemon/protocol";
import type { DaemonLogger } from "../src/utils/logger";
import { answeredEvents, renderBody } from "./helpers/daemon-e2e";
import { loggedLines, logLines, renderEventsOf } from "./helpers/daemon-log";
import {
  startDaemon,
  type DaemonOverrides,
  type InWorkerDaemon,
} from "./helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "./helpers/spawn-isolated-daemon";
import { until } from "./helpers/until";

jest.setTimeout(30_000);

// Reads the commit date and the repo's name, and no PR field: the remotes are
// then read after the commit date, so a pass whose commit read is out has a
// launch still to make. A shown PR reads them at the start of the pass.
const CONFIG = `{
  segments: {
    repo: {
      template: "{{ .git.repoName }} {{ .git.committedAt }}",
      bg: "surface",
      fg: "foreground",
    },
  },
  root: { h: ["repo"] },
}`;

const REPLY_BUDGET_MS = 10_000;

describe("a daemon built while a closed one's work unwinds", () => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let bin: string;
  let up: InWorkerDaemon[];

  const start = (overrides?: DaemonOverrides): InWorkerDaemon => {
    const daemon = startDaemon(env, overrides);
    up.push(daemon);
    return daemon;
  };

  const renderOf = (sessionId: string): Record<string, unknown> => ({
    v: PROTOCOL_VERSION,
    kind: "render",
    deadline: Date.now() + REPLY_BUDGET_MS,
    ...renderBody(sessionId, projectDir),
  });

  // What the pass asked `git`, each call by its subcommand.
  const asked = (): string[] => {
    const file = path.join(bin, "calls");
    return existsSync(file)
      ? readFileSync(file, "utf8").trim().split("\n")
      : [];
  };

  beforeEach(() => {
    up = [];
    ({ env, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-restart-launch"));
    projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-restart-"));
    mkdirSync(path.join(projectDir, ".git"));
    const configDir = path.join(env.XDG_CONFIG_HOME!, "cc-candybar");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "config.json5"), CONFIG);
    bin = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-restart-bin-"));
    // A status with an oid, so the pass goes on to the commit date, and a
    // commit read that stays out, so the close finds it there. The close ends
    // it, and a launch the close did not reach ends by the launch's timeout.
    const git = path.join(bin, "git");
    writeFileSync(
      git,
      `#!/bin/sh
for word in "$@"; do
  case "$word" in
    status|log|config) echo "$word" >> ${JSON.stringify(path.join(bin, "calls"))}; break ;;
  esac
done
case "$word" in
  status) printf '# branch.oid 0123456789abcdef\\n# branch.head main\\n' ;;
  log) exec sleep 20 ;;
esac
`,
    );
    chmodSync(git, 0o755);
    env = { ...env, PATH: `${bin}${path.delimiter}${env.PATH ?? ""}` };
  });

  afterEach(async () => {
    for (const daemon of up.reverse()) await daemon.stop();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("its next launch is refused, and neither the new daemon's stats nor its close sees it", async () => {
    const first = start();
    const answer = first
      .send(renderOf("restart-git"), REPLY_BUDGET_MS)
      .catch(() => null);
    await until(() => asked().includes("log"), "the pass's commit read");

    await first.daemon.close(NO_TMUX_AT_EXIT);
    const second = start();

    // What says the launch was tried: a count of the calls `git` saw reads the
    // same whether the pass went on to it or had not got there yet.
    const refused = () => first.daemon.stats.subprocessRefused.get("git");
    await until(() => refused() === 1, "the pass's next launch refused");
    expect(asked()).toEqual(["status", "log"]);
    expect(second.daemon.stats.subprocessTotal).toBe(0);
    expect(second.daemon.stats.subprocessRefused.size).toBe(0);

    await second.daemon.close(NO_TMUX_AT_EXIT);
    expect(refused()).toBe(1);
    expect(asked()).toEqual(["status", "log"]);
    for (const daemon of up.splice(0).reverse()) await daemon.stop();
    await answer;
  });

  test("a launch its rate limit refused runs at once on the next daemon", async () => {
    const open = { bin: "/bin/echo", category: "click.open" } as const;
    const first = start();
    expect(first.daemon.launcher.launchSync(open)).toMatchObject({ ok: true });
    expect(first.daemon.launcher.launchSync(open)).toMatchObject({
      reason: "rate-limited",
    });

    await first.daemon.close(NO_TMUX_AT_EXIT);
    const second = start();

    expect(second.daemon.launcher.launchSync(open)).toMatchObject({ ok: true });
  });

  test("a line of its work says whose it is, and no count of the next daemon's events reads it", async () => {
    const sid = "restart-late-line";
    const first = start();
    const answer = first.daemon
      .handle(
        renderOf(sid) as unknown as Request,
        () => false,
        first.daemon.clock.monotonic(),
        () => false,
      )
      .catch(() => null);

    await first.daemon.close(NO_TMUX_AT_EXIT);
    const second = start();
    await answer;

    const late = await loggedLines(
      env,
      (lines) => lines.filter((l) => l.includes(`after close: render sid=`)),
      (picked) => picked.length === 1,
      "the render event of a daemon that closed under it",
    );
    expect(late[0]).toContain(sid);
    expect(renderEventsOf(logLines(env), sid)).toEqual([]);
    expect(answeredEvents(second.log, sid)).toEqual([]);
  });

  // A debounced write already awaiting its file when the close runs finishes
  // after it, and storage is built before the daemon is.
  test("what its storage logs after the close says whose it is", async () => {
    let storageLog: DaemonLogger = () => {
      throw new Error("the daemon handed its storage no log");
    };
    const first = start({
      storage: (log) => {
        storageLog = log;
        return {};
      },
    });

    await first.daemon.close(NO_TMUX_AT_EXIT);
    start();
    storageLog("warn", "a write that outlived its daemon");

    await loggedLines(
      env,
      (lines) =>
        lines.filter((l) =>
          l.includes("after close: a write that outlived its daemon"),
        ),
      (picked) => picked.length === 1,
      "the storage line of a daemon that closed under it",
    );
  });
});
