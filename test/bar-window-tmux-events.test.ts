// [LAW:behavior-not-structure] Only the real tmux server can prove its
// command client is unattached and its client-closed hook survives a hard kill.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reservationLease } from "../src/bar-window/reservation";
import { watchTmuxEvents } from "../src/bar-window/tmux-events";
import { WORLD } from "./helpers/host";
import { tmuxServer } from "./helpers/private-tmux";

test("window geometry observes a private server and releases just its own hooks on death", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ccb-layout-"));
  const tmux = tmuxServer(dir, { cols: 80, rows: 24 });
  const title = "cc-candybar-window-test";
  let watcher: ReturnType<typeof watchTmuxEvents> | undefined;
  try {
    // An older tmux still used by the pane surface cannot install this
    // observer. It must fail visibly and leave the server untouched.
    let events = true;
    try {
      tmux.run("wait-for", "-El", "@ccb_version_probe");
    } catch {
      events = false;
    }
    if (events) {
      tmux.run(
        "set-hook",
        "-t",
        "bar",
        "client-closed[user]",
        "set-hook -E @user",
      );
      tmux.run(
        "set-hook",
        "-w",
        "-t",
        tmux.pane,
        "window-layout-changed[user]",
        "set-hook -E @user",
      );
    }
    const hooks = () => [
      tmux.run("show-hooks", "-g"),
      tmux.run("show-hooks", "-gw"),
      tmux.run("show-hooks", "-t", "bar"),
      tmux.run("show-hooks", "-w", "-t", tmux.pane),
    ];
    const before = hooks();
    const split = (name: string, cmd: string) =>
      tmux
        .run(
          "split-window",
          "-d",
          "-l",
          "1",
          "-t",
          tmux.pane,
          "-T",
          name,
          "-P",
          "-F",
          "#{pane_id}",
          cmd,
        )
        .trim();
    const ids = () =>
      tmux
        .run("list-panes", "-a", "-F", "#{pane_id}")
        .trim()
        .split("\n")
        .sort();
    const held = () =>
      tmux.run("display-message", "-p", `#{${reservationLease(title)}}`).trim();
    // The same title on a running pane and a different owner's empty pane
    // establish the two independent parts of reservation identity.
    if (events) {
      split(title, "exec cat");
      split("cc-candybar-window-other", "");
      split("user-empty", "");
    }
    const survivors = ids();
    let pid: number | null = null;
    let change = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<string>();
    const successor = Promise.withResolvers<void>();
    let initial: number | null = null;
    const launcher = {
      ...WORLD.launcher,
      launchChannel: (
        opts: Parameters<typeof WORLD.launcher.launchChannel>[0],
      ) => {
        const child = WORLD.launcher.launchChannel(opts);
        pid = child.pid;
        return child;
      },
    };
    watcher = watchTmuxEvents(
      { launcher },
      tmux.socket,
      title,
      () => {
        change.resolve();
        if (initial !== null && pid !== initial) successor.resolve();
      },
      (reason) => failure.resolve(reason),
    );
    const untilChanged = () =>
      Promise.race([
        change.promise,
        failure.promise.then((reason) => {
          throw new Error(reason);
        }),
      ]);
    if (events) {
      await untilChanged();
      expect(tmux.run("list-clients")).toBe("");
      expect(
        tmux
          .run("display-message", "-p", "-t", "bar", "#{session_attached}")
          .trim(),
      ).toBe("0");
      change = Promise.withResolvers<void>();
      const reserved = split(title, "");
      await untilChanged();
      initial = pid;
      const firstLease = held();
      expect(firstLease).toMatch(/^ccb_window_/);
      tmux.run(
        "set-hook",
        "-t",
        "bar",
        "client-resized[another_user]",
        "set-hook -E @another",
      );
      await Promise.race([
        successor.promise,
        failure.promise.then((reason) => {
          throw new Error(reason);
        }),
      ]);
      expect(held()).not.toBe(firstLease);
      expect(held()).toMatch(/^ccb_window_/);
      expect(ids()).toEqual([...survivors, reserved].sort());
      expect(tmux.run("show-hooks", "-t", "bar", "client-resized")).toContain(
        "ccb_window_",
      );
      if (pid === null) throw new Error("geometry observer did not start");
      process.kill(pid, "SIGKILL");
      expect(await failure.promise).toMatch(/SIGKILL/);
      expect(ids()).toEqual(survivors);
      expect(held()).toBe("");
    } else expect(await failure.promise).toMatch(/window geometry observer/);
    await watcher.close();
    if (events) {
      const resized = tmux.run("show-hooks", "-t", "bar", "client-resized");
      expect(resized).toContain("client-resized[another_user]");
      expect(resized).not.toContain("ccb_window_");
      tmux.run("set-hook", "-u", "-t", "bar", "client-resized");
    }
    expect(hooks()).toEqual(before);
  } finally {
    await watcher?.close();
    tmux.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
