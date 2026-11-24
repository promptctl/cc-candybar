// [LAW:no-shared-mutable-globals] A launch carries its owner, so a daemon built
// in a process where a closed one's work is still unwinding lends that work
// nothing: not a launch, not a rate limit, and not its log. Each case restarts a
// daemon in this worker with no wait between the close and the build, which is
// the order a real process can never reach.

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

import {
  classifyInbound,
  PROTOCOL_VERSION,
  type Request,
} from "../../../src/daemon/foundations/protocol";
import type { DaemonLogger } from "../../../src/utils/logger";
import { renderBody } from "../../helpers/daemon-e2e";
import { loggedLines } from "../../../scripts/lib/daemon/log";
import {
  startDaemon,
  type DaemonOverrides,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../../scripts/lib/daemon/isolated";
import { until } from "../../../scripts/lib/until";

jest.setTimeout(30_000);

// Reads the commit date and the repo's name. A pass reads the remote for the
// PR at its start, beside the status, and the repo's remotes again after the
// commit date — the repo has no config file to memoise them by — so a pass
// whose commit read is out has a launch still to make.
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

    await (await first.daemon.close()).settled;
    const second = start();

    // What says the launch was tried: a count of the calls `git` saw reads the
    // same whether the pass went on to it or had not got there yet.
    const refused = () => first.daemon.stats.subprocessRefused.get("git");
    await until(() => refused() === 1, "the pass's next launch refused");
    // The remote read and the status are launched at once, so which reaches
    // `git` first is the scheduler's.
    expect(asked().sort()).toEqual(["config", "log", "status"]);
    expect(second.daemon.stats.subprocessTotal).toBe(0);
    expect(second.daemon.stats.subprocessRefused.size).toBe(0);

    await (await second.daemon.close()).settled;
    expect(refused()).toBe(1);
    expect(asked().sort()).toEqual(["config", "log", "status"]);
    for (const daemon of up.splice(0).reverse()) await daemon.stop();
    await answer;
  });

  test("a launch its rate limit refused runs at once on the next daemon", async () => {
    const open = { bin: "/bin/echo", category: "click.open" } as const;
    const first = start();
    expect(await first.daemon.launcher.launch(open)).toMatchObject({
      ok: true,
    });
    expect(await first.daemon.launcher.launch(open)).toMatchObject({
      reason: "rate-limited",
    });

    await (await first.daemon.close()).settled;
    const second = start();

    expect(await second.daemon.launcher.launch(open)).toMatchObject({
      ok: true,
    });
  });

  // The close ends what it interrupts: a render waiting on its world ends
  // its wait at the close, so its event is the closing daemon's own, said
  // once, however the next daemon's start falls against it.
  test("a render the close interrupts ends with it, its event said once by the daemon that drew it", async () => {
    const sid = "restart-late-line";
    const first = start();
    const answer = first.daemon
      .handle(
        classifyInbound(renderOf(sid) as unknown as Request),
        () => false,
        first.daemon.stats.accept(),
        () => false,
      )
      .catch(() => null);

    await (await first.daemon.close()).settled;
    start();
    await answer;

    // Said as the close's last steps run or once it returned, as the turns
    // fall: either way the closing daemon's, and once.
    const said = await loggedLines(
      env,
      (lines) => lines.filter((l) => l.includes(`render sid=${sid} `)),
      (picked) => picked.length === 1,
      "the render event of the daemon the close interrupted",
    );
    expect(said[0]).toContain(" ended=closed ");
  });

  // A debounced write already awaiting its file when the close runs finishes
  // after it, and storage is built before the daemon is.
  test("what its storage logs after the close says whose it is", async () => {
    let storageLog: DaemonLogger = () => {
      throw new Error("the daemon handed its storage no log");
    };
    const first = start({
      profile: (log) => {
        storageLog = log;
        return {};
      },
    });

    await (await first.daemon.close()).settled;
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
