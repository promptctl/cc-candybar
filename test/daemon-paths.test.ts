import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DaemonLog, logLines } from "../src/daemon/log";
import { daemonPaths } from "../src/daemon/paths";
import { productionAdapters } from "../src/daemon/production-adapters";
import { processLauncher } from "../src/proc/launch";

// [LAW:effects-at-boundaries] A daemon is aimed by the paths value it is built
// over (candybar-testing-ihvy.yfv), so one aimed at a temporary directory
// writes there and nowhere the environment names. The environment here names
// directories that stay empty, so a write that went to the environment's
// layout, and not the value's, is a file in one of them.
describe("a daemon aimed by its paths value", () => {
  let root: string;
  let ambient: string[];
  const saved = { ...process.env };

  const tree = (dir: string): string[] =>
    fs.readdirSync(dir, { recursive: true, withFileTypes: false }).map(String);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-paths-"));
    ambient = ["state", "cache", "registry", "sockets"].map((name) => {
      const dir = path.join(root, "ambient", name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    });
    process.env.XDG_STATE_HOME = ambient[0];
    process.env.XDG_CACHE_HOME = ambient[1];
    process.env.CC_CANDYBAR_DAEMON_REGISTRY_DIR = ambient[2];
    process.env.CC_CANDYBAR_SOCKET = path.join(ambient[3]!, "socket");
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const aimedEnv = (): NodeJS.ProcessEnv => ({
    XDG_STATE_HOME: path.join(root, "aimed", "state"),
    XDG_CACHE_HOME: path.join(root, "aimed", "cache"),
    CC_CANDYBAR_DAEMON_REGISTRY_DIR: path.join(root, "aimed", "registry"),
    CC_CANDYBAR_SOCKET: path.join(root, "aimed", "sockets", "socket"),
  });

  test("every path of the value is under the directories its environment names", () => {
    const aimed = daemonPaths(aimedEnv());
    expect(
      Object.values(aimed).filter((p) => !p.startsWith(path.join(root, "aimed"))),
    ).toEqual([]);
  });

  test("what its adapters write lands under the value, and the environment's directories stay empty", async () => {
    const aimed = daemonPaths(aimedEnv());
    const daemonLog = new DaemonLog(aimed.log);
    try {
      const adapters = productionAdapters(aimed, daemonLog);

      daemonLog.log("info", "a line");
      await daemonLog.drained();

      const storage = adapters.storage(() => {});
      storage.session.save({ s1: { theme: "x" } });
      storage.session.flush();
      storage.history.save({});
      adapters.doctorStores.clicked.update((seen) => [...seen, "kitty"]);
      adapters.linkSigner.sign({
        sessionId: "s1",
        action: "a",
        declaration: "[]",
        evaluated: "{}",
      });
      const limits = adapters.limits({
        startedAtMs: 0,
        exit: () => {},
        launcher: processLauncher,
        log: () => {},
      });
      limits.writeMemoryReport(path.join(limits.snapshotDir, "report.txt"), "r");
      limits.writeLogNow();

      expect(logLines(aimed.log).join("\n")).toContain("a line");
      expect(fs.existsSync(aimed.sessionState)).toBe(true);
      expect(fs.existsSync(path.join(aimed.state, "link.key"))).toBe(true);
      expect(fs.existsSync(path.join(aimed.state, "report.txt"))).toBe(true);
      expect(ambient.flatMap(tree)).toEqual([]);
    } finally {
      daemonLog.dispose();
    }
  });
});
