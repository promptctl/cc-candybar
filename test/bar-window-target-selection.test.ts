import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clientKey, type Availability } from "../src/bar-window/availability";
import { WindowLayout } from "../src/bar-window/layout";
import { reservationLease } from "../src/bar-window/reservation";
import { WORLD } from "./helpers/host";
import { tmuxServer } from "./helpers/private-tmux";

// tmux owns the real reservation. Two synthetic terminal observations let
// this test exercise minimize, restore and scrollback without a display.
test("one panel follows a visible attachment and retires only its unusable reservation", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ccb-attachments-"));
  const tmux = tmuxServer(dir, { cols: 80, rows: 24 });
  const a = { tty: "/dev/ttys001", pid: 1001 },
    b = { tty: "/dev/ttys002", pid: 1002 };
  const title = "cc-candybar-window-selection";
  const observations = new Map<string, Availability>();
  let attached = [a, b];
  let survivor = false;
  try {
    const [session, window] = tmux
      .run(
        "display-message",
        "-p",
        "-t",
        tmux.pane,
        "#{session_id} #{window_id}",
      )
      .trim()
      .split(" ");
    const layout = new WindowLayout(
      {
        launch: async (spec) => {
          if (spec.args?.[2] !== "list-clients")
            return WORLD.launcher.launch(spec);
          const stdout = attached
            .map((c, i) =>
              [
                c.tty,
                c.pid,
                session,
                window,
                0,
                10 - i,
                0,
                0,
                "bottom",
                "on",
              ].join("|"),
            )
            .join("\n");
          return { ok: true, stdout, stderr: "", exitCode: 0 };
        },
      },
      { socket: tmux.socket, pane: tmux.pane },
      title,
    );
    const visible = (client: typeof a) =>
      observations.set(clientKey(client), {
        kind: "availability",
        ...client,
        state: "visible",
        columns: 80,
        rows: 24,
      });
    const hidden = (client: typeof a) =>
      observations.set(clientKey(client), {
        kind: "availability",
        ...client,
        state: "hidden",
        reason: "Terminal minimized",
      });
    visible(a);
    visible(b);
    const locate = (placement: "inset" | "docked", preferred = a, rows = 2) =>
      layout.locate(placement, rows, preferred, observations);
    expect((await locate("docked")).selected).toEqual(a);
    hidden(a);
    expect((await locate("docked")).selected).toEqual(b);
    hidden(b);
    const neither = await locate("docked", b);
    expect(neither.selected).toBeUndefined();
    expect(neither.clients).toHaveLength(2);
    visible(a);
    expect((await locate("docked", b)).selected).toEqual(a);
    if (!tmux.run("list-commands", "split-window").includes("[-T title]"))
      return;
    tmux.run("set-option", "-g", reservationLease(title), "1");
    const reserved = () =>
      tmux
        .run("list-panes", "-a", "-F", "#{pane_title}")
        .trim()
        .split("\n")
        .filter((t) => t === title);
    expect((await locate("inset")).layout).toMatchObject({
      placement: "inset",
      pid: a.pid,
      width: 80,
      height: 2,
    });
    expect(reserved()).toHaveLength(1);
    observations.set(clientKey(a), {
      kind: "availability",
      ...a,
      state: "locating",
    });
    expect((await locate("inset")).layout.placement).toBe("hidden");
    expect(reserved()).toHaveLength(1);
    observations.set(clientKey(a), {
      kind: "availability",
      ...a,
      state: "visible",
      reason: "No measured grid",
    });
    expect((await locate("inset")).issue).toBe("No measured grid");
    expect(reserved()).toHaveLength(0);
    visible(b);
    expect((await locate("inset")).selected).toEqual(b);
    expect(reserved()).toHaveLength(1);
    attached = [];
    expect((await locate("inset", b)).selected).toBeUndefined();
    expect(reserved()).toHaveLength(0);
    attached = [b];
    expect((await locate("inset", b, 50)).issue).toMatch(/too small/);
    expect(reserved()).toHaveLength(0);
    expect((await locate("inset", b)).selected).toEqual(b);
    tmux.run("new-session", "-d", "-s", "survivor");
    survivor = true;
    tmux.run("kill-pane", "-t", tmux.pane);
    expect((await locate("inset", b)).closed).toBe(true);
    expect(reserved()).toHaveLength(0);
    expect(tmux.run("list-sessions", "-F", "#{session_name}").trim()).toBe(
      "survivor",
    );
  } finally {
    if (survivor) tmux.run("kill-session", "-t", "survivor");
    tmux.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
