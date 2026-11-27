import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { systemTimekeeper } from "../scripts/lib/system-clock";
import {
  systemWatchDirectory,
  WatcherRegistry,
} from "../src/daemon/cache/watchers";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { systemProbe } from "../src/daemon/process-fingerprint";
import {
  createTmuxSourceEdges,
  TmuxSourceAuthority,
} from "../src/daemon/tmux-source-authority";
import { writeAtomic } from "../src/utils/atomic-write";
import { processLauncher } from "./helpers/host";
import { tmuxServer, type TmuxServer } from "./helpers/private-tmux";

test("a legacy render finds only the interactive record on its own private pane, including an atomic /clear before the next render", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "candy-owner-"));
  const servers: TmuxServer[] = [];
  const registry = new WatcherRegistry({
    clock: systemTimekeeper,
    watchDirectory: systemWatchDirectory,
  });
  const first = sessionIdOf("old"),
    next = sessionIdOf("new");
  const handoff = Promise.withResolvers<void>();
  const confirmed = jest.fn((_source, _sid, _pid) => {
    if (_sid === next) handoff.resolve();
  });
  const authority = new TmuxSourceAuthority({
    ...createTmuxSourceEdges(processLauncher, registry),
    confirmed,
    log: () => {},
  });
  try {
    const targets = ["one", "two"].map((name) => {
      const dir = path.join(root, name);
      mkdirSync(dir);
      const server = tmuxServer(dir, { cols: 90, rows: 25 });
      servers.push(server);
      const [serverPid, pid, tty] = server
        .run(
          "display-message",
          "-t",
          server.pane,
          "-p",
          "#{pid} #{pane_pid} #{pane_tty}",
        )
        .trim()
        .split(" ");
      const source = {
        socket: server.socket,
        pane: server.pane,
        truecolor: null,
      };
      authority.observed(server.socket, {
        serverPid: Number(serverPid),
        panes: new Map([[server.pane, { pid: Number(pid), tty: tty! }]]),
      });
      return { source, pid: Number(pid) };
    });
    const [a, b] = targets;
    expect(a!.source.pane).toBe(b!.source.pane);
    const pid = a!.pid;
    const start = await systemProbe(processLauncher).startTime(pid);
    if (start.kind !== "start") throw new Error(start.detail);
    const info =
      process.platform === "linux"
        ? {
            pidDomain: `linux::${readlinkSync(`/proc/${pid}/ns/pid`)}`,
            procStart: readFileSync(`/proc/${pid}/stat`, "utf8")
              .split(") ")
              .at(-1)!
              .split(" ")[19],
          }
        : { pidDomain: "darwin", procStart: start.token };
    const records = path.join(root, "sessions");
    mkdirSync(records);
    const file = path.join(records, `${pid}.json`);
    const put = (sessionId: string, procStart = info.procStart) =>
      writeAtomic(
        file,
        JSON.stringify({
          ...info,
          pid,
          kind: "interactive",
          entrypoint: "cli",
          sessionId,
          procStart,
        }),
      );
    put(first, "reused-pid");
    await authority.report(a!.source, first, undefined, root);
    expect(authority.session(a!.source)).toBeNull();
    put(first);
    await authority.report(a!.source, first, pid, root);
    await authority.report(b!.source, first, undefined, root);
    expect(authority.session(b!.source)).toBeNull();
    expect(authority.session(a!.source)).toBe(first);
    await authority.report(a!.source, next, pid, root);
    await authority.report(
      a!.source,
      sessionIdOf("unrelated"),
      process.pid,
      root,
    );
    expect(authority.session(a!.source)).toBe(first);
    put(next);
    await handoff.promise;
    expect(authority.session(a!.source)).toBe(next);
  } finally {
    authority.close();
    registry.closeAll();
    for (const server of servers) server.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
