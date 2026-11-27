import { createHash } from "node:crypto";
import type { Launcher } from "../proc/launcher.js";
import { runTmuxAsync, serverObserverHookPrefix } from "../proc/tmux.js";
import { singleQuoted } from "../shell-word.js";

const events = new Set([
  "client-attached",
  "client-detached",
  "client-session-changed",
  "session-created",
  "session-closed",
  "session-window-changed",
  "window-layout-changed",
  "window-pane-changed",
  "window-linked",
  "window-unlinked",
  "window-zoomed",
  "window-unzoomed",
  "pane-moved",
  "pane-died",
  "pane-exited",
  "after-select-pane",
  "after-select-window",
  "after-resize-pane",
  "after-swap-pane",
  "after-break-pane",
  "after-join-pane",
  "after-move-window",
  "after-swap-window",
  "after-split-window",
  "after-set-hook",
  "after-set-option",
]);
const globalContext = "%4294967296"; // No uint32 pane id; only global formats resolve.
const command = (...words: string[]) => words.map(singleQuoted).join(" ");
const paneIds = "#{session_id} #{window_id} #{pane_id}";
const paneFacts =
  "P #{pane_id} #{session_id} #{session_attached} #{window_active} #{window_zoomed_flag} #{pane_active} #{?mouse,1,0} #{pane_pid} #{?pane_tty,#{pane_tty},-}";

type Scope = string;
function scopeArgs(scope: Scope): string[] {
  switch (scope[0]) {
    case "g":
      return scope === "gw" ? ["-gw"] : ["-g"];
    case "$":
      return ["-t", scope];
    case "@":
      return ["-w", "-t", scope];
    case "%":
      return ["-p", "-t", scope];
    default:
      throw new Error("invalid tmux hook scope");
  }
}

interface Slot {
  scope: Scope;
  name: string;
  indices: Map<string, string>;
  parents: readonly string[];
}
export class ObserverServer {
  private readonly prefix: string;
  private readonly action: string;
  private readonly dirty: string;
  private readonly scopesDirty: string;
  private readonly live: string;
  private readonly expected: string;
  private readonly hook: string;
  private namedSlots = false;
  constructor(
    private readonly launcher: Launcher,
    readonly socket: string,
    readonly token: string,
    readonly pid: string,
  ) {
    if (!/^[0-9a-f]{32}$/.test(token) || !/^[1-9]\d*$/.test(pid))
      throw new Error("invalid tmux observer identity");
    this.prefix = serverObserverHookPrefix + token;
    this.action = "@" + this.prefix;
    this.live = this.action + "_live";
    this.dirty = this.action + "_dirty";
    this.scopesDirty = this.action + "_hooks";
    this.expected = this.action + "_body";
    this.hook = 'run-shell -C "#{' + this.action + '}"';
  }
  private async run(args: string[], source?: string) {
    const result = await runTmuxAsync(
      this.launcher,
      { socket: this.socket },
      "frames.visibility",
      ["-N", ...args],
      source,
    );
    if (result.kind !== "ok") throw new Error(result.reason);
    return result.stdout;
  }
  private program(
    lines: string[],
    condition = "#{==:#{pid}," + this.pid + "}",
  ) {
    return this.run(
      ["source-file", "-"],
      "if-shell -F '" +
        condition +
        "' {\n" +
        lines.join("\n") +
        "\n} { display-message -p OBSERVER_RETIRED }\n",
    ).then((out) => {
      if (out.trimEnd().endsWith("OBSERVER_RETIRED"))
        throw new Error("tmux server/observer generation changed");
      return out;
    });
  }
  private get current(): string {
    return "#{&&:#{==:#{pid}," + this.pid + "},#{" + this.live + "}}";
  }
  private async tables(): Promise<Slot[]> {
    const members = await this.run(["list-panes", "-a", "-F", paneIds]);
    const scopes = new Set(["g", "gw"]);
    const windowOf = new Map<string, string>();
    for (const row of members.trimEnd().split("\n")) {
      if (!/^\$\d+ @\d+ %\d+$/.test(row))
        throw new Error("invalid tmux hook target list");
      const ids = row.split(" ");
      ids.forEach((s) => scopes.add(s));
      windowOf.set(ids[2]!, ids[1]!);
    }
    const lines = Array.from(scopes, (scope) => {
      const table = [
        command("display-message", "-p", "S " + scope.replace("%", "%%")),
        command("show-hooks", ...scopeArgs(scope)),
      ].join(" ; ");
      if (scope.startsWith("g")) return table;
      const id =
        scope[0] === "$"
          ? "session_id"
          : scope[0] === "@"
            ? "window_id"
            : "pane_id";
      // A scope can end between inventory and this read; never retarget its
      // table to a different pane, window or session.
      return `if-shell -F -t '${scope}' '#{==:#{${id}},${scope}}' { ${table} }`;
    });
    const result = await this.program(lines);
    const slots = new Map<string, Slot>();
    let scope = "";
    for (const line of result.trimEnd().split("\n")) {
      if (line.startsWith("S ") && scopes.has(line.slice(2))) {
        scope = line.slice(2);
        continue;
      }
      const match = /^([a-z-]+)(?:\[([^\]]+)\])?(?: (.*))?$/.exec(line);
      if (!match || !events.has(match[1]!)) continue;
      const name = match[1]!,
        key = scope + " " + name;
      let slot = slots.get(key);
      if (!slot) {
        const window = windowOf.get(scope);
        slot = {
          scope,
          name,
          indices: new Map(),
          parents: window ? ["g", "gw", window] : ["g", "gw"],
        };
        slots.set(key, slot);
      }
      if (match[2] !== undefined) slot.indices.set(match[2], match[3] ?? "");
    }
    return [...slots.values()];
  }
  async arm() {
    // Probe the addressed server. A keyed slot lets the floating-window
    // owner distinguish host registration from a user's geometry-hook edits.
    const probe = "after-set-hook[" + serverObserverHookPrefix + "probe]";
    const keys = await runTmuxAsync(
      this.launcher,
      { socket: this.socket },
      "frames.visibility",
      ["-N", "show-hooks", "-g", probe],
    );
    if (keys.kind === "ok") this.namedSlots = true;
    else if (
      keys.kind !== "failed" ||
      !["invalid option: ", "ambiguous option: "].some((diagnostic) =>
        keys.reason.includes(diagnostic + probe),
      )
    )
      throw new Error(keys.reason);

    // Keep event work in the tmux server. A single transition to dirty owns
    // the classic wait channel's one pending wake, including between clients.
    const edit =
      "#{||:#{==:#{hook},after-set-hook},#{==:#{hook},after-set-option}}";
    const relevant = `#{m/r:^(${[...events].join("|")})([[]|$),#{hook_argument_0}}`;
    const newScope =
      "#{m/r:^(session-created|window-linked|after-split-window|pane-moved)$,#{hook}}";
    const scopes = `#{||:${newScope},#{&&:${edit},${relevant}}}`;
    const wake = `if-shell -F '#{!:#{${this.dirty}}}' { set-option -s ${this.dirty} 1 ; wait-for -S ${this.prefix} }`;
    const topology = `set-option -s ${this.scopesDirty} 1 ; ${wake}`;
    const changed = `if-shell -F '${scopes}' { ${topology} } { if-shell -F '#{||:#{!:${edit}},#{==:#{hook_argument_0},mouse}}' { ${wake} } }`;
    const action = `if-shell -F '${this.current}' { ${changed} }`;
    await this.program([
      command("set-option", "-so", this.live, "1"),
      command("set-option", "-so", this.dirty, "1"),
      command("set-option", "-so", this.expected, this.hook),
      command("set-option", "-so", this.action, action),
    ]);
    await this.renew();
  }
  async renew() {
    // Consume the topology-edit obligation before discovery. A user edit at
    // any point after this boundary is still owed, even during installation.
    await this.program(
      [command("set-option", "-su", this.scopesDirty)],
      this.current,
    );
    const slots = await this.tables();
    if (
      !slots.some((s) => s.name === "pane-exited") ||
      !slots.some((s) => s.name === "after-set-hook")
    )
      throw new Error("tmux lacks required observer hooks");
    const lines: string[] = [];
    const references = new Map<string, string>();
    // Parent tables precede child tables, including a pane's window. A local
    // array that disappeared after discovery now inherits our parent entry:
    // detect it *in the installing command* and preserve that inheritance.
    for (const { scope, name, indices, parents } of slots) {
      const key = scope + " " + name;
      const own = [...indices].find(([, body]) => body === this.hook);
      if (own) {
        references.set(key, name + "[" + own[0] + "]");
        continue;
      }
      let index =
        (createHash("sha256")
          .update(this.token + scope + name)
          .digest()
          .readUInt32BE(0) %
          1_000_000_000) +
        100_000;
      const keyAt = (n: number) =>
        this.namedSlots ? this.prefix + "_" + n : String(n);
      while (indices.has(keyAt(index))) index++;
      const ref = name + "[" + keyAt(index) + "]";
      references.set(key, ref);
      const install = command(
        "set-option",
        "-qo",
        ...scopeArgs(scope),
        ref,
        this.hook,
      );
      let authorized = this.current;
      if (!scope.startsWith("g")) {
        const id =
          scope[0] === "$"
            ? "session_id"
            : scope[0] === "@"
              ? "window_id"
              : "pane_id";
        authorized = `#{&&:${authorized},#{==:#{${id}},${scope}}}`;
        for (const parent of parents) {
          const inherited = references.get(parent + " " + name);
          if (inherited)
            authorized = `#{&&:${authorized},#{!=:#{${inherited}},#{${this.expected}}}}`;
        }
      }
      const target = scope.startsWith("g") ? globalContext : scope;
      lines.push(`if-shell -F -t '${target}' '${authorized}' { ${install} }`);
    }
    if (lines.length) await this.program(lines, this.current);
  }
  async snapshot() {
    return this.program(
      [
        command("set-option", "-su", this.dirty),
        command("display-message", "-p", "B #{pid}"),
        command("list-panes", "-a", "-F", paneFacts),
        command("list-clients", "-F", "C #{session_id} #{client_control_mode}"),
        command("display-message", "-p", "E #{pid}"),
        // A scope edit during renewal occurred while the preceding wake was
        // already outstanding. Give that obligation exactly one new wake at
        // the beginning of this generation, before accepting another signal.
        `if-shell -F '#{${this.scopesDirty}}' { set-option -s ${this.dirty} 1 ; wait-for -S ${this.prefix} }`,
      ],
      this.current,
    );
  }
  async pending() {
    const answer = (
      await this.program(
        [
          command(
            "display-message",
            "-p",
            "D#{" + this.dirty + "} H#{" + this.scopesDirty + "}",
          ),
        ],
        this.current,
      )
    ).trim();
    if (!/^D1? H1?$/.test(answer))
      throw new Error("invalid tmux observer dirty state");
    return { dirty: answer.startsWith("D1"), renew: answer.endsWith("H1") };
  }
  async wait(signal: AbortSignal) {
    const r = await this.launcher.launch({
      bin: "tmux",
      args: ["-N", "-S", this.socket, "wait-for", this.prefix],
      signal,
      category: "frames.visibility",
    });
    if (!r.ok)
      throw new Error(
        "tmux observer wait ended: " + (r.stderr.trim() || r.reason),
      );
    if (r.stdout !== "")
      throw new Error("unexpected bytes on tmux observer wake channel");
  }
  async retire() {
    // An extinct or replaced server has no entries from this generation.
    const identity = await runTmuxAsync(
      this.launcher,
      { socket: this.socket },
      "frames.visibility",
      ["-N", "display-message", "-p", "#{pid} #{" + this.live + "}"],
    );
    if (identity.kind === "failed" && identity.serverGone) return;
    if (identity.kind !== "ok") throw new Error(identity.reason);
    if (![this.pid + " 1", this.pid + " 0"].includes(identity.stdout.trim()))
      return;
    // Revoke writes before enumerating: a killed guardian's final queued
    // registration can no longer install after this sweep.
    await this.program([command("set-option", "-s", this.live, "0")]);
    const slots = await this.tables();
    const lines: string[] = [];
    for (const { scope, name, indices } of slots) {
      for (const [index, body] of indices) {
        const suffix = index.startsWith(this.prefix + "_")
          ? index.slice(this.prefix.length + 1)
          : index;
        if (body !== this.hook || !/^\d+$/.test(suffix)) continue;
        const ref = name + "[" + index + "]",
          target = scope.startsWith("g") ? globalContext : scope;
        lines.push(
          "if-shell -F -t " +
            singleQuoted(target) +
            " '#{==:#{" +
            ref +
            "},#{" +
            this.expected +
            "}}' { " +
            command("set-hook", "-u", ...scopeArgs(scope), ref) +
            " }",
        );
      }
    }
    for (const option of [
      this.expected,
      this.action,
      this.dirty,
      this.scopesDirty,
    ])
      lines.push(command("set-option", "-su", option));
    // A locked channel cannot disappear on the first signal. The second
    // leaves its woken bit set, so unlock disposes it even after waiter death.
    for (const flag of ["-L", "-S", "-S", "-U"])
      lines.push(command("wait-for", flag, this.prefix));
    lines.push(command("set-option", "-su", this.live));
    await this.program(lines);
  }
}
