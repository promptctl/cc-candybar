import fs from "node:fs";
import { hostOf } from "./helpers/host";
import { unscriptedLauncher } from "./helpers/fake-launcher";
import os from "node:os";
import path from "node:path";

import { HOME_ENV, NAME_ENV, RUNTIME_DIR_ENV, homeOf } from "../src/daemon/home";
import { DaemonLog, logLines } from "../src/daemon/log";
import { daemonPaths } from "../src/daemon/paths";
import { productionAdapters } from "../src/daemon/production-adapters";
import { systemTimekeeper } from "../src/time";

// [LAW:effects-at-boundaries] A daemon is aimed by the home it is built over,
// so one under a home of its own writes there and nowhere another home names.
// The ambient home's directories stay empty, so a write that went to it, and
// not the aimed one, is a file in them.
describe("a daemon aimed by its home", () => {
  let root: string;

  const tree = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { recursive: true, withFileTypes: false }).map(String)
      : [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-paths-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const homeNamed = (name: string) =>
    homeOf(
      hostOf({
        [HOME_ENV]: path.join(root, name),
        [NAME_ENV]: name,
        [RUNTIME_DIR_ENV]: path.join(root, "run"),
      }),
    );

  test("every path of the value is under its root, but the socket, which is the runtime directory's", () => {
    const aimed = daemonPaths(homeNamed("aimed"));
    const { socket, lease, storedRoot, ...underRoot } = aimed;
    expect(
      [...Object.values(underRoot), storedRoot.dir].filter((p) => !p.startsWith(path.join(root, "aimed"))),
    ).toEqual([]);
    expect(path.dirname(socket)).toBe(path.join(root, "run"));
    expect(path.dirname(lease)).toBe(path.join(root, "run"));
  });

  test("what its adapters write lands under the home, and another home's directories stay empty", async () => {
    const aimed = daemonPaths(homeNamed("aimed"));
    const ambient = homeNamed("ambient");
    const daemonLog = new DaemonLog(aimed.log, systemTimekeeper);
    try {
      const adapters = productionAdapters(aimed, daemonLog, systemTimekeeper);

      daemonLog.log("info", "a line");
      await daemonLog.drained();

      const storage = adapters.storage(() => {}, adapters.filesystem);
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
        launcher: unscriptedLauncher,
        log: () => {},
      });
      limits.writeMemoryReport(path.join(limits.snapshotDir, "report.txt"), "r");
      limits.writeLogNow();

      expect(logLines(aimed.log).join("\n")).toContain("a line");
      expect(fs.existsSync(aimed.sessionState)).toBe(true);
      expect(fs.existsSync(path.join(aimed.state, "link.key"))).toBe(true);
      expect(fs.existsSync(path.join(aimed.state, "report.txt"))).toBe(true);
      expect(tree(ambient.kind === "named" ? ambient.root : "")).toEqual([]);
    } finally {
      daemonLog.dispose();
    }
  });
});
