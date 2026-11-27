import { matchesLegacyCommand, legacyPeerOn } from "./legacy-bar-pane.js";
import { INSTANCE, PANE_ID } from "./pane-subscription.js";
import { runTmuxAsync } from "../proc/tmux.js";
import { OWNER_CONTEXT, type Launcher } from "../proc/launcher.js";
import { shellWord } from "../shell-word.js";
import type { TmuxHint } from "../tmux-hint.js";
import { digestOf } from "../utils/plain.js";
import type { BarPaneEdge, BarPaneHost, FoundPane } from "./lane-setup.js";

// The split records this invocation before reporting its new ID. All variable
// shell words are quoted once in EXEC. The gate runs on the drawing pane and
// completes before even a missing follower executable can trigger pane-died.
const GATE =
  '"$CC_CANDYBAR_TMUX" -S "$CC_CANDYBAR_PANE_SOCKET" set-option -pt "$TMUX_PANE" remain-on-exit off && exec /bin/sh -c "$CC_CANDYBAR_PANE_EXEC"';
const PRINTED_GATE = '/bin/sh -c "' + GATE.replace(/["$]/g, "\\$&") + '" ';
function owner(source: TmuxHint, serverPid: number, host: BarPaneHost): string {
  return (
    "candybar-pane-" +
    digestOf([source.socket, source.pane, serverPid, host.socket])
  );
}

export function productionBarPaneEdge(launcher: Launcher): BarPaneEdge {
  const run = async (source: TmuxHint, args: string[]) => {
    const result = await runTmuxAsync(launcher, source, "lane.tmux", args);
    if (result.kind !== "ok") throw new Error(result.reason);
    return result.stdout;
  };
  // Command-list braces received as distinct argv are literal words. The
  // nested tmux command receives each argument quoted for tmux's parser.
  const word = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const guarded = async (source: TmuxHint, pid: number, args: string[]) => {
    const out = await run(source, [
      "if-shell",
      "-F",
      "-t",
      source.pane,
      `#{==:#{pid},${pid}}`,
      args.map(word).join(" "),
      "display-message -p changed-server",
    ]);
    if (out.trim() === "changed-server")
      throw new Error("tmux server incarnation changed");
    return out;
  };
  return {
    async find(source, serverPid, host) {
      const marker = owner(source, serverPid, host);
      const text = await run(source, [
        "display-message",
        "-p",
        "#{pid}",
        ";",
        "list-panes",
        "-a",
        "-f",
        `#{||:#{m:*${marker} *,#{pane_start_command}},#{m:* bar-pane *,#{pane_start_command}}}`,
        "-F",
        "#{pane_id} #{pane_pid} #{pane_start_command}",
      ]);
      const [pid, ...rows] = text.trimEnd().split("\n");
      if (pid !== String(serverPid))
        throw new Error("tmux returned a different server");
      const prefix = PRINTED_GATE + marker + " ";
      const found = new Map<string, FoundPane>();
      for (const line of rows) {
        const [drawing, root, ...rest] = line.split(" ");
        if (!drawing || !PANE_ID.test(drawing))
          throw new Error("tmux returned incomplete managed-pane metadata");
        const cmd = rest.join(" ");
        if (!cmd.startsWith(prefix)) {
          if (
            !matchesLegacyCommand(cmd, [
              ...host.node,
              host.bundle,
              "bar-pane",
              source.pane,
            ])
          )
            continue;
          const pid = Number(root);
          if (!Number.isSafeInteger(pid) || pid <= 0)
            throw new Error("legacy pane process is unavailable");
          found.set(drawing, {
            drawing,
            pid,
            command: cmd,
            grant: (await legacyPeerOn(launcher, pid, host.socket))
              ? "connected"
              : "unknown",
          });
          continue;
        }
        const instance = cmd.slice(prefix.length);
        if (INSTANCE.test(instance)) found.set(drawing, { drawing, instance });
      }
      if (found.size > 1)
        throw new Error("multiple managed bar panes claim this source");
      return [...found.values()][0] ?? null;
    },
    async open(source, serverPid, host, instance) {
      if (!INSTANCE.test(instance))
        throw new Error("invalid bar pane instance");
      const which = await launcher.launch({
        ...OWNER_CONTEXT,
        bin: "/bin/sh",
        args: ["-c", "command -v tmux"],
        category: "lane.tmux",
        timeoutMs: 2000,
      });
      const binary = which.stdout.trim();
      if (!which.ok || !binary.startsWith("/") || binary.includes("\n"))
        throw new Error("cannot resolve the tmux executable for the bar pane");
      const argv = [
        ...host.node,
        host.bundle,
        "bar-pane",
        source.pane,
        instance,
      ];
      const drawing = (
        await guarded(source, serverPid, [
          "split-window",
          "-d",
          "-v",
          "-l",
          "1",
          "-t",
          source.pane,
          "-P",
          "-F",
          "#{pane_id}",
          "-e",
          "CC_CANDYBAR_SOCKET=" + host.socket,
          "-e",
          "CC_CANDYBAR_TMUX=" + binary,
          "-e",
          "CC_CANDYBAR_PANE_SOCKET=" + source.socket,
          "-e",
          "CC_CANDYBAR_PANE_EXEC=exec " + argv.map(shellWord).join(" "),
          "/bin/sh",
          "-c",
          GATE,
          owner(source, serverPid, host),
          instance,
        ])
      ).trim();
      if (!PANE_ID.test(drawing) || drawing === source.pane)
        throw new Error("tmux split returned no distinct drawing pane ID");
      return { drawing, instance };
    },
    async retire(source, serverPid, host, pane) {
      // [LAW:single-enforcer] Check the immutable command and server on the
      // same tmux queue as the kill. A reused socket cannot name our pane.
      if (!PANE_ID.test(pane.drawing))
        throw new Error("invalid drawing pane ID");
      const legacy = "grant" in pane;
      if (legacy ? pane.grant !== "connected" : !INSTANCE.test(pane.instance))
        throw new Error("unverified drawing pane identity");
      if (legacy && !(await legacyPeerOn(launcher, pane.pid, host.socket)))
        throw new Error(
          "legacy pane daemon connection changed before retirement",
        );
      const expected = legacy
        ? pane.command
        : PRINTED_GATE + owner(source, serverPid, host) + " " + pane.instance;
      const literal = expected
        .replaceAll("#", "##")
        .replaceAll(",", "#,")
        .replaceAll("}", "#}");
      const commandCheck = `#{==:#{pane_start_command},${literal}}`;
      const physical = legacy
        ? `#{&&:#{==:#{pane_pid},${pane.pid}},${commandCheck}}`
        : commandCheck;
      // tmux quotes the comparison's literal expansion via an environment-free
      // format. The fixed gate contains no format delimiters or commas.
      const result = await run(source, [
        "if-shell",
        "-F",
        "-t",
        pane.drawing,
        `#{&&:#{==:#{pid},${serverPid}},${physical}}`,
        "kill-pane -t " + pane.drawing,
        "display-message -p retirement-mismatch",
      ]);
      if (result.trim())
        throw new Error("tmux drawing pane changed before retirement");
    },
  };
}
