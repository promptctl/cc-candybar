// An unattached tmux command client hears geometry changes. It never joins a
// session: doing so would change the count and visibility it is here to observe.

import { randomUUID } from "node:crypto";
import { reservationLease, reservationPredicate } from "./reservation.js";
import type { World } from "../host.js";
import { whyFailed } from "../proc/launcher.js";
import { runTmuxAsync } from "../proc/tmux.js";
import { singleQuoted } from "../shell-word.js";
import { lineSplitter } from "../renderer-interface/wire.js";

const GEOMETRY_EVENTS = [
  "client-attached",
  "client-detached",
  "client-session-changed",
  "client-resized",
  "session-window-changed",
  "window-layout-changed",
  "window-resized",
  "window-zoomed",
  "window-unzoomed",
  "window-pane-changed",
  "pane-moved",
  "window-linked",
  "window-unlinked",
  "session-closed",
] as const;

const OWNER = "ccb_window_";
const HOOKS = new Set<string>([
  ...GEOMETRY_EVENTS,
  "client-closed",
  "after-set-hook",
  "after-set-option",
  "after-refresh-client",
]);

// Each local table lists only the names of its own hook arrays. An overriding
// array hides the entire global array. Adding our member only where a local
// array already exists preserves inheritance of every user's global hook.
const localNames = (scope: string): string =>
  `#{O/${scope}:#{?option_is_hook,#{option_name} ,}}`;
const LOCAL_HOOKS = [
  "#{session_id} #{window_id} #{pane_id}",
  localNames("s"),
  localNames("w"),
  localNames("p"),
].join("|");
const HOOK_TABLES = `#{S:#{W:#{P:${LOCAL_HOOKS}~}}}`;

interface Hook {
  readonly name: string;
  readonly scope: readonly string[];
}

function hooksOf(panes: string): Hook[] {
  const scopes = new Map<string, Hook>();
  if (!/^[a-zA-Z0-9_$%@|~ -]+$/.test(panes) || !panes.endsWith("~"))
    throw new Error(
      "tmux returned an invalid geometry hook table (tmux 3.8 required)",
    );
  for (const raw of panes.split("~")) {
    if (!raw) continue;
    const [ids, session = "", window = "", pane = ""] = raw.split("|");
    const match = /^(\$\d+) (@\d+) (%\d+)$/.exec(ids ?? "");
    if (!match)
      throw new Error("tmux returned an invalid geometry hook target");
    const tables = [
      { names: session, scope: ["-t", match[1]!] },
      { names: window, scope: ["-w", "-t", match[2]!] },
      { names: pane, scope: ["-p", "-t", match[3]!] },
    ];
    for (const { names, scope } of tables) {
      for (const name of names.split(" ")) {
        if (HOOKS.has(name))
          scopes.set(`${scope.join(" ")} ${name}`, { name, scope });
      }
    }
  }
  return [
    ...[...HOOKS].map((name) => ({ name, scope: ["-g"] })),
    ...scopes.values(),
  ];
}

// tmux obtains its source file from the invoking command client. A private
// descriptor carries the program, past tmux's 16 KiB limit on a command
// argument. Its control stdin stays open, so the watcher remains unattached.
// exec preserves the PID tmux uses in its pipe-backed client name.
const WATCH = [
  'IFS= read -r -d "" program || exit 1',
  'exec 3<<<"${program//WATCHER_PID/$$}"',
  "unset program",
  'exec tmux -N -S "$1" -C source-file /dev/fd/3',
].join("\n");

const command = (words: readonly string[]): string =>
  words.map(singleQuoted).join(" ");

function programFor(
  hooks: readonly Hook[],
  key: string,
  snapshot: string,
  title: string,
): { readonly source: string; readonly release: string } {
  const event = `@${key}`;
  const named = (name: string) => `${name}[${key}]`;
  const remove = hooks.map(({ name, scope }) => [
    "set-option",
    "-qu",
    ...scope,
    named(name),
  ]);
  // All scope ids were parsed above. Quoting also makes $session literal
  // when tmux parses its own hook commands. No user's hook body is read.
  const lease = reservationLease(title);
  const mine = reservationPredicate(title);
  // run-shell -C runs tmux commands, without invoking a shell. Only pane IDs
  // enter the command text. Recheck the title and empty command at execution
  // in case the user has repurposed a pane or a successor now owns the lease.
  const unleased = `#{&&:#{!:#{${lease}}},${mine}}`;
  const kill = `if-shell -F -t #{pane_id} "#{l:${unleased}}" "kill-pane -t #{pane_id}" ; `;
  const panes = `#{S:#{W:#{P:#{?${mine},${kill},}}}}`;
  const renewing = `${key}_renewing`;
  const holding = `#{||:#{==:#{${lease}},${key}},#{==:#{${lease}},${renewing}}}`;
  const releaseLease = `if-shell -F '${holding}' { set-option -su ${lease} ; ${command(["run-shell", "-C", panes])} }`;
  const cleanup = remove.map(command).join(" ; ");
  const owner = "client-WATCHER_PID";
  const died = `if-shell -F '#{==:#{hook_client},${owner}}' { ${cleanup} ; ${releaseLease} }`;
  const dirty = `set-hook -E ${event}`;
  const geometryOption =
    "#{m/r:^(status|status-position|window-size|pane-border-status)$,#{hook_argument_0}}";
  const userHook = `#{&&:#{m/r:^(${[...HOOKS].join("|")})(\\[|$),#{hook_argument_0}},#{!:#{m:*${OWNER}*,#{hook_argument_0}}}}`;
  // A config edit can create a new local override. Wake our waiter so this
  // follower can start a successor while this client still guards its lease.
  const wake = `if-shell -F '#{==:#{${lease}},${key}}' { set-option -s ${lease} ${renewing} ; wait-for -E -w ${owner} ${event} }`;
  const edited = `if-shell -F '${userHook}' { ${wake} } { if-shell -F '${geometryOption}' { ${dirty} } }`;
  const action = (name: string) => {
    if (name === "client-closed") return died;
    if (name === "after-refresh-client") {
      // Explicit viewport panning moves cells on screen without resizing a pane.
      const viewport = ["c", "C", "U", "D", "L", "R"]
        .map((flag) => `#{hook_flag_${flag}}`)
        .join("");
      return `if-shell -F '${viewport}' { ${dirty} }`;
    }
    if (name === "after-set-hook" || name === "after-set-option") return edited;
    return dirty;
  };
  // Register on death before anything else. All the setup commands run in
  // one tmux server turn up to wait-for, so ready cannot precede registration.
  const ordered = [
    ...hooks.filter((h) => h.name === "client-closed"),
    ...hooks.filter((h) => h.name !== "client-closed"),
  ];
  // Compare the same tables again inside the server command queue. If any
  // local mask or target changed during discovery, install nothing and retry.
  const matches = `#{==:${HOOK_TABLES},${snapshot}}`;
  const ready = ["display-message", "-p", `ready=${key}`];
  const reconfigure = ["display-message", "-p", `reconfigure=${key}`];
  const source = [
    `if-shell -F ${singleQuoted(matches)} {`,
    ...ordered.map(({ name, scope }) =>
      command(["set-hook", ...scope, named(name), action(name)]),
    ),
    command(["set-option", "-s", lease, key]),
    command(ready),
    // -v emits events before testing the predicate. Zero keeps the same
    // waiter armed through the geometry reads its previous event triggered.
    command(["wait-for", "-Ev", "-F", "0", event]),
    "}",
    command(reconfigure),
    // A channel can report exit before its last stdout. Stay until the
    // follower acknowledges this generation's retirement by closing it.
    command(["wait-for", "-E", "-F", "0", `${event}_retire`]),
  ].join("\n");
  // A user may replace a whole hook table during disconnect, including the
  // notification of our client's death. While the follower lives it also
  // checks release; a server that already removed our key runs no commands.
  const stillOwned = (scope: string) =>
    `#{O/${scope}:#{?#{==:#{option_array_key},${key}},1,}}`;
  const surviving =
    stillOwned("gs") +
    stillOwned("gw") +
    `#{S:${stillOwned("s")}#{W:${stillOwned("w")}#{P:${stillOwned("p")}}}}`;
  return {
    source,
    release: `if-shell -F ${singleQuoted(surviving)} { ${cleanup} }\n${releaseLease}\n`,
  };
}

export interface TmuxEvents {
  close(): Promise<void>;
}

export function watchTmuxEvents(
  world: Pick<World, "launcher">,
  socket: string,
  reservationTitle: string,
  changed: () => void,
  failed: (reason: string) => void,
): TmuxEvents {
  const cancel = new AbortController();
  // [LAW:single-enforcer] Each client guards the reservation until a successor
  // claims its lease inside tmux. Either side of a crash during handoff has
  // an installed client-closed hook with the current lease key.
  let owner: AbortController | undefined;
  const pending = new Set<Promise<void>>();
  let error: Error | undefined;
  function stop(cause: unknown): void {
    error ??= cause instanceof Error ? cause : new Error(String(cause));
    cancel.abort();
  }
  async function watch(): Promise<void> {
    while (!cancel.signal.aborted) {
      const key = OWNER + randomUUID().replaceAll("-", "");
      const local = await runTmuxAsync(
        world.launcher,
        { socket },
        "bar-window.tmux",
        // An older tmux must refuse before a hook has been installed. Both
        // observations run on the same server before this client exits.
        [
          "-N",
          "wait-for",
          "-El",
          `@${key}`,
          ";",
          "display-message",
          "-p",
          HOOK_TABLES,
        ],
      );
      if (cancel.signal.aborted) return;
      if (local.kind !== "ok")
        throw new Error(
          `cannot observe tmux 3.8 layout events: ${local.reason}`,
        );
      const snapshot = local.stdout.trimEnd();
      const program = programFor(
        hooksOf(snapshot),
        key,
        snapshot,
        reservationTitle,
      );
      const commandError = new AbortController();
      const retire = new AbortController();
      let next!: () => void;
      const transition = new Promise<void>((resolve) => {
        next = resolve;
      });
      let detail = "";
      const stdout = lineSplitter((line) => {
        if (
          cancel.signal.aborted ||
          retire.signal.aborted ||
          commandError.signal.aborted
        )
          return;
        if (line.startsWith("%error ")) commandError.abort();
        else if (line === `ready=${key}`) {
          owner?.abort();
          owner = retire;
          changed();
        } else if (line === `event=@${key}` && owner === retire) changed();
        else if (line === `reconfigure=${key}`) {
          // A failed snapshot installed nothing. A live predecessor, however,
          // remains until its successor has emitted ready.
          if (owner !== retire) retire.abort();
          next();
        } else if (line !== "" && !line.startsWith("%") && !line.includes("="))
          detail = line;
      });
      const stderr = lineSplitter((line) => {
        if (line !== "") detail = line;
      });
      const child = world.launcher.launchChannel({
        bin: "/bin/bash",
        args: ["-c", WATCH, "window-geometry", socket],
        category: "bar-window.tmux",
        signal: AbortSignal.any([
          cancel.signal,
          commandError.signal,
          retire.signal,
        ]),
        heard: { stdout: stdout.push, stderr: stderr.push },
      });
      child.write(program.source + "\0");
      const finished = child.ended
        .then(async (result) => {
          stdout.end();
          stderr.end();
          const release = await runTmuxAsync(
            world.launcher,
            { socket },
            "bar-window.tmux",
            ["-N", "source-file", "-"],
            program.release,
          );
          // A server that ended owns no hooks. Anything else that refused a
          // requested release must be heard by the caller.
          if (
            release.kind !== "ok" &&
            !/no server running|No such file or directory|Connection refused/.test(
              release.reason,
            )
          )
            throw new Error(
              `could not release tmux geometry hooks: ${release.reason}`,
            );
          if (cancel.signal.aborted || retire.signal.aborted) return;
          const reason = commandError.signal.aborted
            ? "tmux refused a geometry hook"
            : result.ok
              ? "tmux disconnected"
              : whyFailed(result);
          throw new Error(`${reason}${detail ? `: ${detail}` : ""}`);
        })
        .catch(stop)
        .finally(() => {
          pending.delete(finished);
          next();
        });
      pending.add(finished);
      await transition;
    }
  }
  const ended = watch()
    .catch(stop)
    .then(async () => {
      await Promise.all(pending);
      if (error)
        failed(`window geometry observer on ${socket}: ${error.message}`);
    });
  return {
    close: () => {
      cancel.abort();
      return ended;
    },
  };
}
