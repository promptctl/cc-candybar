// [LAW:behavior-not-structure] Two renderers drawing rows on one real tmux
// server, clicked as a person clicks them: a client attached inside an outer
// tmux pane, mouse on, an SGR press at a column of the bottom row. Each row's
// click reaches the renderer that drew it, a press on the window list runs the
// user's own binding, and a row whose session carries no click says so. What
// each renderer laid out is put back when it shuts down, and the user's
// binding comes back once the last renderer has gone (docs/design/gather-and-
// renderer.md, section 18; src/tmux-status/click-binding.ts).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseRendererName } from "../../../src/daemon/home";
import { cellWidth } from "../../../src/render/picker";
import {
  CLICK_OPTION,
  NO_RENDERER,
  RENDERER_OPTION,
} from "../../../src/tmux-status/click-binding";
import { claudeHolds } from "../../helpers/claude-record";
import { configFlag, killAndWait, render } from "../../helpers/daemon-e2e";
import { logLines } from "../../helpers/daemon-log";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "../../helpers/spawn-isolated-daemon";
import { builtBundle } from "../../helpers/spawn-test-daemon";
import { until } from "../../helpers/until";

const HAS_TMUX = spawnSync("tmux", ["-V"]).status === 0;
const COLS = 120;
const ROWS = 30;
// The user's own MouseDown1Status: the server's window switch, and a mark
// that it ran.
// tmux's double-click window, which no option sets (measured, tmux 3.8: two
// presses 0.4 s apart are a double click, 0.6 s apart two clicks).
const DOUBLE_CLICK_MS = 600;
const USER_BINDING = "switch-client -t = \\; set-option -g @ccb-pressed yes";

(HAS_TMUX ? test : test.skip)(
  "each row's click reaches the renderer that drew it, the window list runs the user's binding, and the last renderer out puts it back",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ccb-tmux-row-"));
    const inner = path.join(dir, "inner.sock");
    const outer = path.join(dir, "outer.sock");
    const tmuxOn =
      (socket: string) =>
      (...args: string[]): string => {
        const run = spawnSync("tmux", ["-S", socket, ...args], {
          encoding: "utf8",
        });
        if (run.status !== 0) throw new Error(`tmux ${args[0]}: ${run.stderr}`);
        return run.stdout;
      };
    const tmux = tmuxOn(inner);
    const outside = tmuxOn(outer);
    const config = path.join(dir, "tmux.json5");
    writeFileSync(
      config,
      `{ globals: { renderer: "tmux" }, segments: { mark: { template: 'a mark' } }, root: { h: ['mark'] } }`,
    );
    const a = prepareIsolatedDaemonEnv("ccb-row-a", parseRendererName("rowa"));
    const b = prepareIsolatedDaemonEnv("ccb-row-b", parseRendererName("rowb"));
    const daemons: RunningDaemon[] = [];
    tmux(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "a",
      "-x",
      `${COLS}`,
      "-y",
      `${ROWS}`,
    );
    tmux("new-window", "-d", "-t", "a");
    tmux("new-session", "-d", "-s", "b", "-x", `${COLS}`, "-y", `${ROWS}`);
    tmux("set-option", "-g", "mouse", "on");
    spawnSync("tmux", ["-S", inner, "source-file", "-"], {
      input: `bind-key -T root MouseDown1Status ${USER_BINDING}\n`,
    });
    const binding = (): string =>
      tmux("list-keys", "-T", "root")
        .split("\n")
        .find((l) => / MouseDown1Status /.test(l)) ?? "";
    const userLine = binding();
    try {
      // The client a person would have: attached inside the outer pane, so a
      // press written to that pane reaches it as their terminal's would.
      outside(
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "outer",
        "-x",
        `${COLS}`,
        "-y",
        `${ROWS}`,
      );
      outside("set-option", "-g", "status", "off");
      outside("set-option", "-g", "default-terminal", "xterm-256color");
      outside(
        "respawn-pane",
        "-k",
        "-t",
        "outer",
        `env -u TMUX tmux -S ${inner} attach -t a`,
      );
      await until(
        () => tmux("list-clients", "-F", "#{client_name}").trim() !== "",
        "the inner client's attach",
      );
      const client = tmux("list-clients", "-F", "#{client_name}").trim();
      const screen = (): string[] =>
        outside("capture-pane", "-p", "-t", "outer").split("\n");
      const own = (s: string): string => tmux("show-options", "-t", s);
      const before = { a: own("a"), b: own("b") };
      // An SGR press and release at a 0-based cell of the client's screen, as
      // a person clicks: a beat after the last, because tmux reads a press
      // inside its double-click window as the second click of one, which no
      // MouseDown1Status binding hears.
      let pressed = 0;
      const press = async (x: number, y: number): Promise<void> => {
        const wait = pressed + DOUBLE_CLICK_MS - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        pressed = Date.now();
        for (const end of ["M", "m"])
          outside(
            "send-keys",
            "-t",
            "outer",
            "-H",
            ...[...Buffer.from(`\x1b[<0;${x + 1};${y + 1}${end}`)].map((byte) =>
              byte.toString(16),
            ),
          );
      };
      // Where on the screen a session's first link range is drawn: its text,
      // read from the row tmux draws it from, found on the captured screen.
      const rangeCell = (s: string): { x: number; y: number } => {
        const row = tmux("show-options", "-v", "-t", s, "@cc-candybar-row-0");
        const inside = /#\[range=user\|ccb[0-9a-z]+\](.*?)#\[norange\]/.exec(
          row,
        )?.[1];
        if (inside === undefined)
          throw new Error(`no ccb range on ${s}'s row: ${JSON.stringify(row)}`);
        const text = inside
          .replace(/#\[[^\]]*\]/g, "")
          .replace(/##/g, "#")
          .trim();
        const lines = screen();
        const y = lines.findIndex((l) => l.includes(text));
        if (y === -1)
          throw new Error(
            `${JSON.stringify(text)} is not on the screen:\n${lines.join("\n")}`,
          );
        return { x: cellWidth(lines[y]!.slice(0, lines[y]!.indexOf(text))), y };
      };
      // [LAW:no-silent-failure] What a press that never landed leaves to read:
      // the presses tmux took and the messages it showed, and the screen.
      const seen = (what: string) => (): string =>
        [
          what,
          ...tmux("show-messages", "-t", client)
            .split("\n")
            .filter((l) => !/ command: /.test(l)),
          ...screen(),
        ].join("\n");
      const clicks = (env: NodeJS.ProcessEnv): string[] =>
        logLines(env).filter(
          (l) => / \[info\] click /.test(l) && l.includes(" verb=range "),
        );
      const drawn = async (
        s: string,
        env: typeof a,
        pane: string,
      ): Promise<void> => {
        // Run by a Claude Code of its own, which holds the row's session.
        const claudeConfigDir = path.join(dir, ".claude");
        const parentPid = s === "a" ? 4001 : 4002;
        claudeHolds(claudeConfigDir, parentPid, `row-${s}`);
        await until(async () => {
          await render(
            env.home,
            `row-${s}`,
            dir,
            {
              termCols: COLS,
              termRows: ROWS,
              tmux: { socket: inner, pane, truecolor: null },
              parentPid,
              claudeConfigDir,
            },
            configFlag(config),
          );
          return /#\[range=user\|ccb/.test(
            tmux("show-options", "-q", "-v", "-t", s, "@cc-candybar-row-0"),
          );
        }, `${s}'s row drawn with a link`);
      };

      // From the built bundle, as an installed renderer runs: the click a
      // session carries runs the url-handle of the bundle that drew it.
      const built = builtBundle(path.join(process.cwd(), "dist", "index.mjs"));
      daemons.push(
        await spawnDaemonWithEnv(a.env, built),
        await spawnDaemonWithEnv(b.env, built),
      );
      // A row is drawn while a client shows its session, so each is drawn
      // where the client is.
      await drawn(
        "a",
        a,
        tmux("display-message", "-p", "-t", "a:0", "#{pane_id}").trim(),
      );
      expect(
        tmux("show-options", "-v", "-t", "a", RENDERER_OPTION).trim(),
      ).toBe("rowa");

      // A press on a's row reaches rowa, and rowb hears nothing.
      await until(
        () => screen().some((l) => l.includes("a mark")),
        "a's row on the screen",
      );
      const onA = rangeCell("a");
      await press(onA.x, onA.y);
      await until(() => clicks(a.env).length > 0, seen("rowa's click event"));
      expect(clicks(a.env)[0]).toContain(" to=rowa ");
      expect(clicks(b.env)).toEqual([]);

      // And one on b's row reaches rowb.
      tmux("switch-client", "-c", client, "-t", "b");
      await drawn(
        "b",
        b,
        tmux("display-message", "-p", "-t", "b", "#{pane_id}").trim(),
      );
      expect(
        tmux("show-options", "-v", "-t", "b", RENDERER_OPTION).trim(),
      ).toBe("rowb");
      await until(
        () =>
          screen().some((l) => l.startsWith("[b]")) &&
          screen().some((l) => l.includes("a mark")),
        "b's row on the screen",
      );
      const onB = rangeCell("b");
      await press(onB.x, onB.y);
      await until(() => clicks(b.env).length > 0, seen("rowb's click event"));
      expect(clicks(b.env)[0]).toContain(" to=rowb ");
      expect(clicks(a.env)).toHaveLength(1);

      // A row whose session carries no click says so where it was clicked.
      tmux("set-option", "-u", "-t", "b", CLICK_OPTION);
      const again = rangeCell("b");
      await press(again.x, again.y);
      // As shown, not as the bound command that carries its text, which tmux
      // logs for every press.
      await until(
        () =>
          tmux("show-messages", "-t", client)
            .split("\n")
            .some((l) => l.includes(NO_RENDERER) && !/ (key|command) /.test(l)),
        seen("the no-renderer message shown"),
      );
      expect(clicks(b.env)).toHaveLength(1);

      // A press on a window in a's window list runs the user's own binding:
      // both of its commands.
      tmux("switch-client", "-c", client, "-t", "a");
      // Back on a, its status is one line until its rows are drawn again, and
      // the window list moves up when they are: the press is aimed once they
      // stand, as b's was.
      await drawn(
        "a",
        a,
        tmux("display-message", "-p", "-t", "a:0", "#{pane_id}").trim(),
      );
      await until(
        () =>
          screen().some((l) => l.startsWith("[a]")) &&
          screen().some((l) => l.includes("a mark")),
        "a's window list and row on the screen",
      );
      const lines = screen();
      const y = lines.findIndex((l) => l.startsWith("[a]"));
      const x = cellWidth(lines[y]!.slice(0, lines[y]!.indexOf("1:")));
      await press(x, y);
      await until(
        () =>
          tmux("show-options", "-g", "-q", "-v", "@ccb-pressed").trim() ===
          "yes",
        seen("the user's binding run"),
      );
      expect(
        tmux("display-message", "-p", "-t", "a", "#{window_index}").trim(),
      ).toBe("1");

      // The first renderer out puts its session back and leaves the binding
      // to the one still drawing; the last puts the user's back.
      await killAndWait(daemons[1]!, "SIGTERM");
      expect(own("b")).toBe(before.b);
      expect(binding()).toContain("#{m:ccb*,#{mouse_status_range}}");
      await killAndWait(daemons[0]!, "SIGTERM");
      expect(own("a")).toBe(before.a);
      expect(binding()).toBe(userLine);
    } finally {
      for (const daemon of daemons) daemon.killTree();
      // Each private server's sessions: tmux exits with its last.
      for (const s of ["a", "b"])
        spawnSync("tmux", ["-S", inner, "kill-session", "-t", s]);
      spawnSync("tmux", ["-S", outer, "kill-session", "-t", "outer"]);
      a.removeTmpDirs();
      b.removeTmpDirs();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
