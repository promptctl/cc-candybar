import { randomBytes } from "node:crypto";
import { ObserverServer } from "../../../src/daemon/tmux-observer-hooks";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { until, throughout } from "../../../scripts/lib/until";
import { productionTmuxServerObserver } from "../../../src/daemon/tmux-server-observer";
import { WORLD } from "../../helpers/host";
import { tmuxServer } from "../../helpers/private-tmux";

const bundle = path.resolve(__dirname, "../../../dist/index.mjs");
const prefix = "ccb_observer_";
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "ccb-obs-"));
  const server = tmuxServer(dir, { cols: 100, rows: 30 });
  const { run, socket } = server;
  const pidFile = path.join(dir, "guardian.pid");
  const entry = path.join(dir, "node");
  writeFileSync(
    entry,
    '#!/bin/sh\necho "$$" > "' +
      pidFile +
      '"\nexec "' +
      process.execPath +
      '" "$@"\n',
    { mode: 0o700 },
  );
  const observer = productionTmuxServerObserver(
    WORLD.launcher,
    [entry],
    bundle,
    dir,
  );
  const follows = new Set<() => void>();
  function follow() {
    const seen: string[] = [];
    const failures: string[] = [];
    const close = observer.observe(socket, {
      snapshot: (s) => seen.push(s),
      lost: (r) => failures.push(r),
    });
    follows.add(close);
    const next = async (predicate: (s: string) => boolean, what: string) => {
      await until(
        () => failures.length > 0 || seen.some(predicate),
        () => what + "; last snapshot: " + seen.at(-1),
        8000,
      );
      expect(failures).toEqual([]);
      return seen.find(predicate)!;
    };
    return { seen, failures, close, next };
  }
  const hooks = () =>
    run("show-hooks", "-g") +
    run("show-hooks", "-gw") +
    run("show-hooks", "-t", "bar");
  const gone = () =>
    until(
      () => !hooks().includes('run-shell -C "#{@' + prefix),
      "observer hook retirement",
    );
  return {
    dir,
    server,
    run,
    follow,
    hooks,
    gone,
    pid: () => Number(readFileSync(pidFile, "utf8")),
    async release() {
      for (const close of follows) close();
      try {
        await gone();
      } finally {
        server.kill();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

test("an unattached observer sees scoped edits, quiet pane exit, selections and zoom across sessions", async () => {
  const r = setup();
  try {
    r.run("new-session", "-d", "-s", "other", "cat");
    r.run(
      "set-hook",
      "-g",
      "after-select-window[42]",
      "set-option -s @user_global yes",
    );
    r.run(
      "set-hook",
      "-t",
      "other",
      "after-select-window[7]",
      "set-option -s @user_local yes",
    );
    const original = r.hooks();
    const source = r
      .run(
        "split-window",
        "-d",
        "-t",
        "other",
        "-P",
        "-F",
        "#{pane_id}",
        "read x",
      )
      .trim();
    const selected = r
      .run("new-window", "-d", "-t", "other", "-P", "-F", "#{pane_id}", "cat")
      .trim();
    const id = r
      .run("display-message", "-p", "-t", "other", "#{session_id}")
      .trim();
    const a = r.follow(),
      b = r.follow();
    const hasSource = (s: string) =>
      s.includes("P " + source + " " + id + " 0");
    await Promise.all([
      a.next(hasSource, "first source"),
      b.next(hasSource, "second source"),
    ]);
    expect(r.run("list-clients")).toBe("");
    expect(
      r
        .run("display-message", "-p", "-t", "other", "#{session_attached}")
        .trim(),
    ).toBe("0");
    a.close();
    r.run("select-window", "-t", selected);
    await b.next(
      (s) => s.includes("P " + selected + " " + id + " 0 1"),
      "other session selects its second window",
    );
    expect(r.run("show-options", "-sv", "@user_local").trim()).toBe("yes");
    r.run("select-window", "-t", source);
    r.run("resize-pane", "-Z", "-t", source);
    await b.next(
      (s) => s.includes("P " + source + " " + id + " 0 1 1 1"),
      "other session zooms the source",
    );
    r.run("set", "-t", "other", "mou", "on");
    await b.next(
      (s) => s.includes("P " + source + " " + id + " 0 1 1 1 1"),
      "mouse is active at source",
    );
    // A newly overriding table must include the observer before the next
    // natural exit. A user's local entry must remain after both leases retire.
    const scope = "pane-exited";
    r.run(
      "set-hook",
      "-p",
      "-t",
      source,
      scope + "[18]",
      "set-option -s @user_exit yes",
    );
    await until(
      () => r.run("show-hooks", "-p", "-t", source, scope).includes(prefix),
      "new overriding hook covered",
    );
    // Exercise the user's local entry while its pane is still a valid hook
    // target. Old tmux may resolve a natural pane-exited after removing it.
    r.run("set-hook", "-R", "-t", source, scope);
    expect(r.run("show-options", "-sv", "@user_exit").trim()).toBe("yes");
    const at = b.seen.length;
    r.run("send-keys", "-t", source, "x", "Enter");
    await until(
      () =>
        b.seen.slice(at).some((s) => !hasSource(s)) || b.failures.length > 0,
      () =>
        "quiet source disappears; real=" +
        r.run("list-panes", "-a", "-F", "#{pane_id} #{pane_dead}") +
        "; snapshots=" +
        JSON.stringify(b.seen.slice(at)) +
        "; failed=" +
        b.failures,
    );
    expect(b.failures).toEqual([]);
    b.close();
    await r.gone();
    expect(r.hooks()).toBe(original);
    expect(r.run("list-clients")).toBe("");
  } finally {
    await r.release();
  }
}, 25000);

test("a killed guardian's existing hooks retire through its host", async () => {
  const r = setup();
  try {
    const original = r.hooks();
    const f = r.follow();
    await f.next((s) => s.includes("P "), "attached private observer");
    expect(r.hooks()).toContain(prefix);
    process.kill(r.pid(), "SIGKILL");
    await until(() => f.failures.length > 0, "guardian loss reaches host");
    await r.gone();
    expect(r.hooks()).toBe(original);
  } finally {
    await r.release();
  }
}, 15000);

test("SIGKILL of the host restores the server's original hooks and client count", async () => {
  const r = setup();
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve(__dirname, "../../fixtures/tmux-observer-host.ts"),
      r.server.socket,
      bundle,
      r.dir,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  try {
    const original = r.hooks();
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error("host exited before its first snapshot")),
      );
    });
    await ready;
    expect(r.hooks()).toContain(prefix);
    child.kill("SIGKILL");
    await r.gone();
    expect(r.hooks()).toBe(original);
    expect(r.run("list-clients")).toBe("");
  } finally {
    child.kill();
    await r.release();
  }
}, 15000);

function heldCommand(dir: string, pattern: string) {
  const native = execFileSync("/bin/sh", ["-c", "command -v tmux"], {
    encoding: "utf8",
  }).trim();
  const ready = path.join(dir, "held"),
    permit = path.join(dir, "release"),
    arm = path.join(dir, "hold-next");
  const log = path.join(dir, "observer-wire");
  const bin = path.join(dir, "tmux");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> "${dir}/tmux-calls"
case "$*" in
  *"source-file -")
    body=$(cat)
    result="${dir}/output.$$"
    printf '%s\\n' "$body" | "${native}" "$@" >"$result"
    status=$?
    case "$body" in
      *"${pattern}"*)
        if mv "${arm}" "${arm}.claimed" 2>/dev/null; then
          cp "$result" "${ready}.tmp" && mv "${ready}.tmp" "${ready}"
          # A real tmux command has already completed. Its client still holds
          # the response, so no ownership decision can use this result yet.
          read answer < "${permit}"
        fi ;;
    esac
    cat "$result" >> "${log}"
    cat "$result"
    rm -f "$result"
    exit "$status" ;;
  *"wait-for ccb_observer_"*) echo $$ >"${dir}/waiter.pid" ;;
esac
exec "${native}" "$@"
`,
    { mode: 0o700 },
  );
  execFileSync("mkfifo", [permit]);
  return {
    ready,
    arm: () => writeFileSync(arm, ""),
    open: () => writeFileSync(permit, "release\n"),
    launcher: {
      ...WORLD.launcher,
      launchDetachedSync: (
        opts: Parameters<typeof WORLD.launcher.launchDetachedSync>[0],
      ) =>
        WORLD.launcher.launchDetachedSync({
          ...opts,
          envOverlay: {
            ...opts.envOverlay,
            PATH: dir + ":" + process.env.PATH,
          },
        }),
    },
    log,
  };
}

test("an event arriving while a snapshot is in flight cannot publish the old result", async () => {
  const r = setup();
  const held = heldCommand(r.dir, "B #{pid}");
  const seen: string[] = [];
  const lost: string[] = [];
  const stop = productionTmuxServerObserver(
    held.launcher,
    [process.execPath],
    bundle,
    r.dir,
  ).observe(r.server.socket, {
    snapshot: (s) => seen.push(s),
    lost: (r) => lost.push(r),
  });
  try {
    const sid = r.run("display-message", "-p", "#{session_id}").trim();
    const other = r
      .run("new-window", "-d", "-P", "-F", "#{pane_id}", "cat")
      .trim();
    await until(
      () => seen.some((s) => s.includes("P " + other + " " + sid + " 0 0")),
      "initial visibility",
    );
    held.arm();
    r.run("select-window", "-t", other);
    await until(
      () => existsSync(held.ready),
      "old visibility response held after server read",
    );
    expect(readFileSync(held.ready, "utf8")).toContain(
      "P " + other + " " + sid + " 0 1",
    );
    const count = seen.length;
    r.run("select-window", "-t", r.server.pane);
    held.open();
    await until(
      () => seen.length > count || lost.length > 0,
      "fresh visibility after release",
    );
    expect(lost).toEqual([]);
    expect(
      seen
        .slice(count)
        .every((s) => s.includes("P " + other + " " + sid + " 0 0")),
    ).toBe(true);
    // A private producer writes into an observed actual pane. A later mouse
    // change proves the observer remains live after the bytes were produced.
    const marker = "CANDYBAR_TEST_TERMINAL_BYTES";
    const done = path.join(r.dir, "produced");
    r.run(
      "split-window",
      "-d",
      `i=0; while [ $i -lt 3000 ]; do echo ${marker}; i=$((i+1)); done; touch '${done}'; exec cat`,
    );
    await until(() => existsSync(done), "private output producer finished");
    const before = seen.length;
    r.run("set-option", "-g", "mouse", "on");
    await until(
      () => seen.length > before,
      "observer responds after pane output",
    );
    const wire = readFileSync(held.log, "utf8");
    expect(wire).toContain("B ");
    expect(wire).not.toMatch(
      /CANDYBAR_TEST_TERMINAL_BYTES|%extended-output|%output/,
    );
    const pidFile = path.join(r.dir, "waiter.pid");
    let waiter = 0;
    await until(() => {
      waiter = Number(readFileSync(pidFile, "utf8"));
      try {
        const args = execFileSync("ps", ["-p", String(waiter), "-o", "args="], {
          encoding: "utf8",
        });
        return (
          args.includes(r.server.socket) &&
          args.includes("wait-for ccb_observer_")
        );
      } catch {
        return false;
      }
    }, "blocking waiter for this exact private socket");
    const calls = path.join(r.dir, "tmux-calls"),
      idle = readFileSync(calls, "utf8");
    // Two former daemon polling periods and four pane periods elapse here.
    await throughout(
      () => readFileSync(calls, "utf8") === idle,
      "no tmux processes started while idle",
      2100,
    );
    process.kill(waiter, "SIGKILL");
    await until(() => lost.length > 0, "guardian reported waiter loss");
    await r.gone();
  } finally {
    stop();
    await r.release();
  }
}, 20000);

test("killing the guardian after hook installation and before its first frame cleans its partial registration", async () => {
  const r = setup(),
    held = heldCommand(r.dir, "'-qo'");
  const frames: string[] = [];
  const errors: string[] = [];
  held.arm();
  const stop = productionTmuxServerObserver(
    held.launcher,
    [path.join(r.dir, "node")],
    bundle,
    r.dir,
  ).observe(r.server.socket, {
    snapshot: (s) => frames.push(s),
    lost: (s) => errors.push(s),
  });
  try {
    await until(
      () => existsSync(held.ready),
      "server committed the hook program",
    );
    expect(frames).toHaveLength(0);
    expect(r.hooks()).toContain(prefix);
    process.kill(r.pid(), "SIGKILL");
    await until(
      () => errors.length > 0,
      "host detects interrupted registration",
    );
    await r.gone();
    expect(r.run("show-options", "-s")).not.toContain(prefix);
  } finally {
    stop();
    await r.release();
  }
}, 15000);

test("the addressed server publishes linked and grouped panes, break/join and real client attachment changes", async () => {
  const r = setup();
  const peers: Array<ReturnType<typeof spawn>> = [];
  try {
    r.run("new-session", "-d", "-s", "other", "cat");
    r.run("new-session", "-d", "-s", "group", "-t", "bar");
    const id = (name: string) =>
      r.run("display-message", "-p", "-t", name, "#{session_id}").trim();
    const bar = id("bar"),
      group = id("group"),
      other = id("other");
    const f = r.follow();
    const membership = (s: string, p: string, session: string) =>
      s.includes("P " + p + " " + session + " ");
    await f.next(
      (s) =>
        membership(s, r.server.pane, bar) &&
        membership(s, r.server.pane, group),
      "group shares its window",
    );
    const apart = r
      .run("split-window", "-d", "-t", "bar", "-P", "-F", "#{pane_id}", "cat")
      .trim();
    await f.next(
      (s) => membership(s, apart, group),
      "split reaches grouped session",
    );
    r.run("break-pane", "-d", "-s", apart, "-t", "other:");
    await f.next(
      (s) => membership(s, apart, other) && !membership(s, apart, bar),
      "break moves pane to other session",
    );
    const target = r
      .run("display-message", "-p", "-t", "bar", "#{pane_id}")
      .trim();
    r.run("join-pane", "-d", "-s", apart, "-t", target);
    await f.next(
      (s) => membership(s, apart, bar) && !membership(s, apart, other),
      "join returns pane to bar",
    );
    const w = r
      .run("new-window", "-d", "-t", "other", "-P", "-F", "#{pane_id}", "cat")
      .trim();
    r.run("link-window", "-s", w, "-t", "bar:81");
    await f.next(
      (s) => [bar, group, other].every((sid) => membership(s, w, sid)),
      "all window memberships survive link",
    );
    const beforeUnlink = f.seen.length;
    r.run("unlink-window", "-t", "bar:81");
    await until(
      () =>
        f.seen
          .slice(beforeUnlink)
          .some(
            (s) =>
              membership(s, w, other) &&
              !membership(s, w, bar) &&
              !membership(s, w, group),
          ),
      "unlink removes only grouped membership",
    );
    r.run("move-window", "-s", w, "-t", "bar:82");
    await f.next(
      (s) => membership(s, w, bar) && !membership(s, w, other),
      "moved window leaves original session",
    );

    const control = spawn(
      "tmux",
      ["-S", r.server.socket, "-C", "attach-session", "-t", "other"],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    peers.push(control);
    await f.next(
      (s) => s.includes("C " + other + " 1"),
      "third-party control client joins other",
    );
    // Another disposable tmux server supplies a real tty for an ordinary
    // client of the observed server. Its sole program exits on detach.
    const ttySocket = path.join(r.dir, "terminal.sock");
    execFileSync("tmux", [
      "-f",
      "/dev/null",
      "-S",
      ttySocket,
      "new-session",
      "-d",
      "-s",
      "terminal",
      "env",
      "-u",
      "TMUX",
      "tmux",
      "-S",
      r.server.socket,
      "attach-session",
      "-t",
      "bar",
    ]);
    await f.next(
      (s) => s.includes("C " + bar + " 0") && s.includes("C " + other + " 1"),
      "regular terminal and third-party control coexist",
    );
    const next = f.seen.length;
    r.run("detach-client", "-s", "bar");
    await until(
      () =>
        f.seen
          .slice(next)
          .some(
            (s) =>
              !s.includes("C " + bar + " 0") && s.includes("C " + other + " 1"),
          ),
      "only the regular terminal detached",
    );
    expect(f.failures).toEqual([]);
  } finally {
    for (const child of peers) child.kill();
    await r.release();
  }
}, 25000);

test("a replaced server at the same socket requires a new observation", async () => {
  const r = setup();
  try {
    const first = r.follow();
    const pid = r.run("display-message", "-p", "#{pid}").trim();
    await first.next(
      (s) => s.startsWith("B " + pid + "\n"),
      "first server answers",
    );
    r.server.kill();
    await until(
      () => first.failures.length > 0,
      "server loss reached subscriber",
    );
    const count = first.seen.length;
    const replacement = tmuxServer(r.dir, { cols: 80, rows: 24 });
    const fresh = r.follow();
    const next = replacement.run("display-message", "-p", "#{pid}").trim();
    expect(next).not.toBe(pid);
    await fresh.next(
      (s) =>
        s.startsWith("B " + next + "\n") && s.trimEnd().endsWith("E " + next),
      "replacement incarnation answers",
    );
    expect(first.seen).toHaveLength(count);
  } finally {
    await r.release();
  }
}, 15000);

test("replacing a hook and unsetting its local override preserves the user's exact configuration", async () => {
  const r = setup();
  try {
    const hook = "after-select-window",
      scope = "bar";
    r.run("set-hook", "-t", scope, hook + "[6]", "display-message prior");
    const f = r.follow();
    await f.next((s) => s.startsWith("B "), "hook discovery complete");
    const global = r
      .run("show-hooks", "-g", hook)
      .split("\n")
      .find((line) => line.includes(prefix));
    if (!global) throw new Error("missing managed global hook");
    const ref = global.split(" ")[0]!;
    const config = path.join(r.dir, "edit.conf");
    writeFileSync(
      config,
      [
        `set-hook -g '${ref}' 'display-message user-replaced'`,
        `set-hook -u -t '${scope}' '${hook}'`,
        `set-hook -t '${scope}' 'after-select-pane[7]' 'display-message new-override'`,
      ].join("\n") + "\n",
    );
    r.run("source-file", config);
    await until(
      () =>
        r.run("show-hooks", "-t", scope, "after-select-pane").includes(prefix),
      "new local override adopted after source-file",
    );
    expect(r.run("show-hooks", "-t", scope, hook).trim()).toBe("");
    f.close();
    await r.gone();
    expect(r.run("show-hooks", "-g", ref).trim()).toBe(
      ref + " display-message user-replaced",
    );
    expect(r.run("show-hooks", "-t", scope, hook).trim()).toBe("");
    expect(r.run("show-hooks", "-t", scope, "after-select-pane").trim()).toBe(
      "after-select-pane[7] display-message new-override",
    );
  } finally {
    await r.release();
  }
}, 15000);

test("an unread registration returns from wait without a native signal", async () => {
  const r = setup();
  const token = randomBytes(16).toString("hex");
  const server = new ObserverServer(
    WORLD.launcher,
    r.server.socket,
    token,
    r.run("display-message", "-p", "#{pid}").trim(),
  );
  const lifetime = new AbortController();
  let waiting: Promise<void> | undefined;
  try {
    await server.arm();
    // Registration starts dirty before the first native waiter exists.
    // A peer may install its own hooks during this first generation.
    expect((await server.pending()).dirty).toBe(true);
    let returned = false;
    waiting = server.wait(lifetime.signal).then(() => {
      returned = true;
    });
    await until(
      () => returned,
      "unread registration without a queued wait-for signal",
    );
    expect(await server.snapshot()).toContain("P " + r.server.pane + " ");
  } finally {
    lifetime.abort();
    await waiting?.catch(() => {});
    await server.retire();
    await r.release();
  }
});

test.each(["direct", "sourced"])(
  "%s hook-table replacement recovers on the next independent pane event",
  async (mode) => {
    const r = setup();
    try {
      r.run("set", "-t", "bar", "mouse", "off");
      const other = r
        .run("split-window", "-d", "-t", "bar", "-P", "-F", "#{pane_id}", "cat")
        .trim();
      const a = r.follow();
      const pane = r.server.pane;
      const mouse = (s: string, on: boolean) =>
        s.split("\n").some((row) => {
          const fields = row.split(" ");
          return (
            fields[0] === "P" &&
            fields[1] === pane &&
            fields[7] === (on ? "1" : "0")
          );
        });
      await a.next((s) => mouse(s, false), "initial mouse off");
      const edits = [
        ["set-hook", "-g", "after-set-hook", "display-message installed"],
        [
          "set-hook",
          "-t",
          "bar",
          "after-set-option",
          "display-message changed",
        ],
      ];
      if (mode === "direct") for (const command of edits) r.run(...command);
      else {
        const file = path.join(r.dir, "user-hooks.conf");
        writeFileSync(
          file,
          edits
            .map((words) => words.map((word) => "'" + word + "'").join(" "))
            .join("\n"),
        );
        r.run("source-file", file);
      }
      r.run("set", "-t", "bar", "mou", "on");
      // Overwriting the trigger can suppress its own notification. A real
      // selection still invokes a separate hook and discovers both edits.
      r.run("select-pane", "-t", other);
      await a.next(
        (s) => mouse(s, true),
        "mouse and overridden hook rediscovered",
      );
      const count = a.seen.length;
      r.run("set", "-t", "bar", "mou", "off");
      await until(
        () => a.seen.slice(count).some((s) => mouse(s, false)),
        "mouse delivered through the repaired local table",
      );
      a.close();
      await r.gone();
      expect(r.run("show-hooks", "-g", "after-set-hook").trim()).toBe(
        "after-set-hook[0] display-message installed",
      );
      expect(r.run("show-hooks", "-t", "bar", "after-set-option").trim()).toBe(
        "after-set-option[0] display-message changed",
      );
    } finally {
      await r.release();
    }
  },
);
