import fs from "node:fs";
import { hostOf, processLauncher } from "./helpers/host";
import os from "node:os";
import path from "node:path";

import { DaemonLog, logLines } from "../src/daemon/log";
import { daemonPaths } from "../src/daemon/paths";
import { productionAdapters } from "../src/daemon/production-adapters";
import { systemTimekeeper } from "../src/time";

// [LAW:effects-at-boundaries] A daemon is aimed by the paths value it is built
// over (candybar-testing-ihvy.yfv), so one aimed at a temporary directory
// writes there and nowhere the environment names. The environment here names
// directories that stay empty, so a write that went to the environment's
// layout, and not the value's, is a file in one of them.
describe("a daemon aimed by its paths value", () => {
  let root: string;
  let ambient: string[];

  const tree = (dir: string): string[] =>
    fs.readdirSync(dir, { recursive: true, withFileTypes: false }).map(String);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-paths-"));
    ambient = ["state", "cache", "registry", "sockets"].map((name) => {
      const dir = path.join(root, "ambient", name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // The environment's layout: nothing is handed a host over it, so a write
  // that reached its paths is a file in one of the ambient directories.
  const ambientEnv = (): NodeJS.ProcessEnv => ({
    XDG_STATE_HOME: ambient[0]!,
    XDG_CACHE_HOME: ambient[1]!,
    CC_CANDYBAR_DAEMON_REGISTRY_DIR: ambient[2]!,
    CC_CANDYBAR_SOCKET: path.join(ambient[3]!, "socket"),
  });

  const aimedEnv = (): NodeJS.ProcessEnv => ({
    XDG_STATE_HOME: path.join(root, "aimed", "state"),
    XDG_CACHE_HOME: path.join(root, "aimed", "cache"),
    CC_CANDYBAR_DAEMON_REGISTRY_DIR: path.join(root, "aimed", "registry"),
    CC_CANDYBAR_SOCKET: path.join(root, "aimed", "sockets", "socket"),
  });

  test("every path of the value is under the directories its environment names", () => {
    const aimed = daemonPaths(hostOf(aimedEnv()));
    expect(
      Object.values(aimed).filter((p) => !p.startsWith(path.join(root, "aimed"))),
    ).toEqual([]);
  });

  test("what its adapters write lands under the value, and the environment's directories stay empty", async () => {
    const aimed = daemonPaths(hostOf(aimedEnv()));
    // The fixture is sound: the ambient layout is the one the directories were made for.
    expect(
      Object.values(daemonPaths(hostOf(ambientEnv()))).filter(
        (p) => !p.startsWith(path.join(root, "ambient")),
      ),
    ).toEqual([]);
    const daemonLog = new DaemonLog(aimed.log, systemTimekeeper);
    try {
      const adapters = productionAdapters(aimed, daemonLog, systemTimekeeper);

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
