// [LAW:behavior-not-structure] The `run` action through what a user and an
// operator see: the load errors a declaration earns, the link a draw makes,
// what a click does with a link (runs the program, or refuses it into the
// session's bar), what the program sees, the bar while it runs and after, and
// the run owner's events and counts. Every view is the daemon's own: a render
// cache over the payload providers, declared by `declareLanes`, drawn from
// `sessionSource`.

import { processLauncher, type Launcher } from "../src/proc/launch";
import { RefreshLedger } from "../src/utils/refresh-ledger";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPayloadProviders } from "../src/daemon/payload-providers";
import { FileEventDelivery } from "../src/daemon/cache/file-events";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import {
  loadFromDisk,
  RenderCache,
  type SessionView,
} from "../src/daemon/cache/render";
import { declareLanes, renderOptionsOf } from "../src/daemon/render-payload";
import { sessionSource, type SessionSource } from "../src/daemon/session-source";
import { SessionState } from "../src/daemon/session-state";
import { EMPTY_HISTORY_DEPTH } from "../src/daemon/settings-history";
import { drawDsl } from "../src/dsl/render";
import { LOADING_GLYPH } from "../src/dsl/node-registry";
import { UNFOLLOWED_FEEDS } from "../src/config/lanes";
import { checkConfig, type CheckOutcome } from "../src/check";
import { parseDslConfig } from "../src/config/dsl-loader";
import { ConfigError } from "../src/config/loader/diagnostics";
import { instantOf } from "../src/utils/instant";
import { Runs, type RunRequest } from "../src/daemon/runs";
import { sessionEnv } from "../src/daemon/session-env";
import { lastClickError } from "../src/daemon/click-error";
import { linkSigner } from "../src/click/link-signer";
import { linkSignerFromKeyFile } from "../src/daemon/link-key";
import { runDeclaration, type RunAction } from "../src/config/action";
import { effectsUrl, VERB_RUN, type EvaluatedRun } from "../src/click/wire";
import {
  BadVerbArgs,
  SESSION_CLIENT_HINTS_KEY,
  SESSION_RENDER_ORIGIN_KEY,
  encodeRenderOrigin,
  type VerbContext,
} from "../src/daemon/verbs";
import { sessionIdOf, type SessionId } from "../src/daemon/session-id";
import type { StorageKey } from "../src/daemon/cache/managed-storage";
import { stripAnsi } from "./helpers/daemon-e2e";
import { linkUrls } from "./helpers/ansi";
import { clickUrl, effectsOf, testVerbContext } from "./helpers/click";
import { TEST_LINK_KEY, TEST_SIGNER } from "./helpers/link-signer";
import { viewFacts } from "./helpers/view-facts";
import { until } from "./helpers/until";
import { untilHeard } from "./helpers/reload-signal";

const SOURCE = `{ scope: "session", refresh: { watch: true }, read: { file: { json: true } } }`;
const STATUS = "plugins.p.status";
// The second plugin's source, which only a run's environment reads.
const DOC = "plugins.q.doc";
const SID = "s1";

let dir: string;
let cleanups: Array<() => void>;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-run-")));
  cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
});
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
});

function write(rel: string, contents: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
  return p;
}

// The fixture program, in the plugin's folder: it writes the session's file
// whole, by rename, with what it saw — its directory and the session variables
// of its environment — and exits `EXIT`, saying `SAY` on stderr.
const PROGRAM = `#!/bin/sh
sid="$CLAUDE_CODE_SESSION_ID"
mkdir -p session
printf '{"home":"%s","cwd":"%s","sid":"%s","project":"%s","config":"%s","tmux":"%s","pane":"%s"}' \\
  "$HOME_VALUE" "$(pwd -P)" "$sid" "$CLAUDE_PROJECT_DIR" "\${CLAUDE_CONFIG_DIR-unset}" "\${TMUX-unset}" "\${TMUX_PANE-unset}" \\
  > "session/.$sid.tmp"
mv "session/.$sid.tmp" "session/$sid.json"
[ -n "$SAY" ] && echo "  $SAY  " >&2
exit "\${EXIT:-0}"
`;

// The fixture plugins. `p`: a session source, a segment drawing it, one
// binding `go` by its spelled name and one binding `go2` by a computed name.
// `q`: a second source, which no segment template reads — only the runs'
// environments do. (A plugin's sources share its session file, so the second
// source is another plugin's.)
function plugin(actions?: string): string {
  write("p/write.sh", PROGRAM);
  fs.chmodSync(path.join(dir, "p/write.sh"), 0o755);
  write(
    "q/plugin.json5",
    `{ sources: { doc: ${SOURCE} }, segments: { unplaced: { template: "q" } } }`,
  );
  return write(
    "p/plugin.json5",
    `{
      sources: { status: ${SOURCE} },
      segments: {
        shown: { when: '{{ hasKey .plugins.p "status" }}', template: 'home={{ .plugins.p.status.home }}' },
        go: { template: '{{ action "plugins.p.go" "[go]" }}' },
        computed: { template: '{{ $n := "plugins.p.go2" }}{{ action $n "[go2]" }}' },
      },
      actions: ${
        actions ??
        `{
        go: { run: ["./write.sh", "{{ .session.id }}"], env: { HOME_VALUE: "{{ .plugins.q.doc.home }}" }, refreshes: ["status"] },
        go2: { run: ["./write.sh"], env: { HOME_VALUE: "{{ .plugins.q.doc.home2 }}" }, refreshes: ["status"] },
      }`
      },
    }`,
  );
}

function config(placed: readonly string[], more = ""): string {
  plugin();
  return write(
    "config.json5",
    `{ plugins: ["./p/plugin.json5", "./q/plugin.json5"], segments: { mine: { template: "mine" } }, root: { h: ${JSON.stringify(placed)} } ${more} }`,
  );
}

const storage = (plugin = "p"): string => path.join(dir, plugin, "session");

function programWrites(sid: string, doc: unknown): void {
  fs.mkdirSync(storage(), { recursive: true });
  const tmp = path.join(storage(), `.${sid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, path.join(storage(), `${sid}.json`));
}

interface Rig {
  readonly cache: RenderCache<SessionSource>;
  readonly providers: ReturnType<typeof createPayloadProviders>;
  readonly sessionState: SessionState;
  readonly runs: Runs;
  readonly lines: string[];
}

// A fake of the launch port: the program runs from the call until the test says
// it exited, so "still running" is a state the test holds, with no process
// behind it and no sleep standing in for it. A close aborts it, as it would a
// child.
function heldLaunch() {
  let exit!: () => void;
  const launch: Launcher["launch"] = (opts) =>
    new Promise((resolve) => {
      exit = () => resolve({ ok: true, stdout: "", stderr: "", exitCode: 0 });
      opts.signal?.addEventListener("abort", () =>
        resolve({ ok: false, reason: "aborted", stdout: "", stderr: "", exitCode: null, signal: null }),
      );
    });
  return { launch, exit: () => exit() };
}

// The daemon's own composition (src/daemon/daemon.ts): the render cache, the
// storage owner, and the run owner over the same storage and session state.
function rig(launch: Launcher["launch"] = processLauncher.launch): Rig {
  const lines: string[] = [];
  const log = (level: string, message: string): void => {
    lines.push(`${level} ${message}`);
  };
  const watchers = new WatcherRegistry({ logger: log });
  const providers = createPayloadProviders({
    launcher: processLauncher,
    watchers,
    fileEvents: new FileEventDelivery({ watchers, logger: log }),
    logger: log,
    ledger: new RefreshLedger(log),
  });
  const sessionState = new SessionState();
  const cache = new RenderCache<SessionSource>(
    {
      launcher: processLauncher,
      sessionState,
      watchers,
      storage: providers.managedStorage,
      signer: TEST_SIGNER,
      log,
      declare: (holds, facts, closure, sources) =>
        declareLanes(providers, holds, facts, closure, sources),
      source: sessionSource({
        providers,
        sessionState,
        history: () => EMPTY_HISTORY_DEPTH,
        navigation: () => 0,
      }),
    },
    { budgetBytes: () => 1024 * 1024 * 1024 },
  );
  const runs = new Runs({
    supersede: (key, sid) => providers.managedStorage.supersede(key, sid),
    launch,
    state: sessionState,
    log,
    now: () => instantOf(new Date()),
  });
  cleanups.push(() => {
    runs.close();
    cache.close();
    providers.gitProvider.close();
    providers.usageStore.close();
    providers.tmuxService.close();
    providers.managedStorage.close();
    watchers.closeAll();
  });
  return { cache, providers, sessionState, runs, lines };
}

function draw(view: SessionView<SessionSource>): {
  readonly text: string;
  readonly links: readonly string[];
  readonly errors: readonly string[];
} {
  const effective = view.source.effective();
  const errors: string[] = [];
  const frame = drawDsl(
    view.state.config,
    view.state.compiled,
    view.store,
    view.registry,
    { drawing: { by: "request" }, feeds: UNFOLLOWED_FEEDS, today: undefined },
    instantOf(new Date()),
    renderOptionsOf(effective, 200),
    { onSegmentError: (id, message) => errors.push(`${id}: ${message}`) },
    effective,
  );
  return { text: stripAnsi(frame.text), links: linkUrls(frame.text), errors };
}

function viewOf(r: Rig, configFile: string, sid = SID): SessionView<SessionSource> {
  const held = r.cache.holdSession(dir, dir, configFile, viewFacts(dir, sid));
  cleanups.push(() => held[Symbol.dispose]());
  return held.view;
}

async function answered(view: SessionView<SessionSource>, name: string): Promise<void> {
  await until(
    () => view.lanes().sources.get(name)?.current().kind !== "pending",
    `${name}'s first read`,
  );
}

// fs.watch goes live after it returns, with no ready signal: the program
// writes again until the view has read what it wrote.
async function writeUntilRead(
  view: SessionView<SessionSource>,
  name: string,
  sid: string,
  doc: Record<string, string>,
): Promise<void> {
  const folder = storage(name.split(".")[1]);
  const read = (): boolean => {
    const r = view.lanes().sources.get(name)?.current();
    return r?.kind === "ok" && JSON.stringify(r.value) === JSON.stringify(doc);
  };
  await untilHeard(
    () => {
      fs.mkdirSync(folder, { recursive: true });
      const tmp = path.join(folder, `.${sid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(doc));
      fs.renameSync(tmp, path.join(folder, `${sid}.json`));
    },
    read,
    `${name}'s write being read`,
  );
}

// The run link a draw made: its URL and what it carries.
function runLink(links: readonly string[], action: string) {
  const found = links
    .map((url) => ({ url, effects: effectsOf(url) }))
    .find(({ effects }) => effects.some((e) => e.verb === VERB_RUN && e.args[1] === action));
  if (found === undefined) throw new Error(`no run link for ${action} in ${JSON.stringify(links)}`);
  const [sid, name, evaluated, mac] = found.effects.find((e) => e.verb === VERB_RUN)!.args as [
    string,
    string,
    string,
    string,
  ];
  return { url: found.url, sid, name, evaluated, mac, drawn: JSON.parse(evaluated) as EvaluatedRun };
}

// What a click on a session's link is handed: the session's recorded render
// and client facts, the config and sources its render state holds, and the
// run owner.
// The declaration a view's config holds for a run, as its link signs it.
const declarationOf = (view: SessionView<SessionSource>, name: string): string =>
  runDeclaration(view.state.config.actions[name] as RunAction);

function clickContext(r: Rig, view: SessionView<SessionSource>, over: Partial<VerbContext> = {}): VerbContext {
  r.sessionState.set(
    SID,
    SESSION_RENDER_ORIGIN_KEY,
    encodeRenderOrigin({ projectDir: dir, cwd: dir, target: { source: "search" } }),
  );
  r.sessionState.set(SID, SESSION_CLIENT_HINTS_KEY, JSON.stringify({ claudeConfigDir: "/u/.claude-x" }));
  return {
    ...testVerbContext(r.sessionState, undefined, view.state.config),
    sourcesFor: () => view.state.sources,
    runs: r.runs,
    ...over,
  };
}

// The session's variables as whichever shell spawned the daemon set them.
function daemonSessionEnv(): void {
  const names = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "TMUX", "TMUX_PANE"];
  const was = names.map((n) => [n, process.env[n]] as const);
  Object.assign(process.env, {
    CLAUDE_CODE_SESSION_ID: "daemon-sid",
    CLAUDE_PROJECT_DIR: "/daemon/project",
    CLAUDE_CONFIG_DIR: "/daemon/.claude",
    TMUX: "/tmp/daemon-tmux,1,0",
    TMUX_PANE: "%99",
  });
  cleanups.push(() => {
    for (const [n, v] of was) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  });
}

describe("a run's declaration", () => {
  function fatal(o: CheckOutcome): string {
    if (o.kind !== "fatal") throw new Error(`expected fatal, got ${JSON.stringify(o)}`);
    return [o.message, ...o.warnings].join("\n");
  }

  test("a plugin's run loads: its refreshes under its namespace, its folder the directory it runs in", () => {
    const r = rig();
    const loaded = loadFromDisk(dir, dir, config(["mine"]), {
      launcher: processLauncher,
      sessionState: r.sessionState,
      storage: r.providers.managedStorage,
      signer: TEST_SIGNER,
    });
    try {
      expect(loaded.error).toBeNull();
      expect(loaded.state!.config.actions["plugins.p.go"]).toEqual({
        run: ["./write.sh", "{{ .session.id }}"],
        env: { HOME_VALUE: "{{ .plugins.q.doc.home }}" },
        refreshes: [STATUS],
        cwd: path.join(dir, "p"),
      });
    } finally {
      loaded.state?.registry.dispose();
    }
  });

  test("a user config's run names a source by its full name and runs in the config file's directory", () => {
    const r = rig();
    plugin();
    const file = write(
      "conf/config.json5",
      `{ plugins: ["../p/plugin.json5"], actions: { mine: { run: ["true"], refreshes: ["${STATUS}"] } }, segments: { mine: { template: '{{ action "mine" "m" }}' } }, root: { h: ["mine"] } }`,
    );
    const loaded = loadFromDisk(dir, dir, file, {
      launcher: processLauncher,
      sessionState: r.sessionState,
      storage: r.providers.managedStorage,
      signer: TEST_SIGNER,
    });
    try {
      expect(loaded.error).toBeNull();
      expect(loaded.state!.config.actions["mine"]).toEqual({
        run: ["true"],
        env: {},
        refreshes: [STATUS],
        cwd: path.join(dir, "conf"),
      });
    } finally {
      loaded.state?.registry.dispose();
    }
  });

  test.each([
    ["an undeclared name", `["nope"]`, `refreshes "plugins.p.nope", which is not declared`],
    ["a variable that is not a source", `["v"]`, `refreshes "plugins.p.v", which is a literal variable`],
  ])("refreshing %s drops the plugin, naming it", async (_what, refreshes, said) => {
    plugin(`{ go: { run: ["./write.sh"], refreshes: ${refreshes} } }, variables: { v: { kind: "literal", value: 1 } }`);
    const file = write(
      "config.json5",
      `{ plugins: ["./p/plugin.json5"], segments: { mine: { template: "mine" } }, root: { h: ["mine"] } }`,
    );
    const message = fatal(await checkConfig(file, dir));
    expect(message).toContain(`plugin ${path.join(dir, "p/plugin.json5")} was not loaded`);
    expect(message).toContain(said);
    expect(message).toContain("a run refreshes only a declared source");
  });

  test("a user config refreshing a name that is no source is its load error", async () => {
    const file = write(
      "config.json5",
      `{ actions: { mine: { run: ["true"], refreshes: ["status"] } }, segments: { mine: { template: '{{ action "mine" "m" }}' } }, root: { h: ["mine"] } }`,
    );
    const message = fatal(await checkConfig(file, dir));
    expect(message).toContain(`actions.mine refreshes "status", which is not declared`);
  });

  test.each([
    ["an item that is not a template", `{ run: ["./write.sh", 3] }`, "actions.mine.run", "each a template string"],
    ["no program", `{ run: [] }`, "actions.mine.run", "the program first and not empty"],
    ["an env value that is not a template", `{ run: ["x"], env: { A: 1 } }`, "actions.mine.env", "to template strings"],
    ["an env name no shell spells", `{ run: ["x"], env: { "A-B": "1" } }`, "actions.mine.env", "variable names"],
    ["a key a run has no such thing as", `{ run: ["x"], cwd: "/" }`, "actions.mine.cwd", "Expected only: run, env, refreshes"],
  ])("%s is a load error naming the field", async (_what, decl, field, said) => {
    const file = write(
      "config.json5",
      `{ actions: { mine: ${decl} }, segments: { mine: { template: '{{ action "mine" "m" }}' } }, root: { h: ["mine"] } }`,
    );
    const message = fatal(await checkConfig(file, dir));
    expect(message).toContain(field);
    expect(message).toContain(said);
  });

  // The bundled default declares no run: a text no file holds has no
  // directory for one to run in, so a run there is refused, naming the text.
  test("a run in a text no file holds is refused: it has no directory to run in", () => {
    let thrown: unknown;
    try {
      parseDslConfig("<default>", `{ actions: { mine: { run: ["true"] } } }`);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(String((thrown as Error).message)).toContain(
      "a run action runs in the directory of the file that declares it, and <default> is no file",
    );
  });
});

describe("a run link", () => {
  // [LAW:single-enforcer] One fold: what the draw evaluates is what the view
  // declared, so a source only a run's environment reads is held and drawn.
  test("the draw evaluates the run into a signed link; a source only its env reads is held and its value carried", async () => {
    const r = rig();
    const view = viewOf(r, config(["plugins.p.shown", "plugins.p.go"]));
    await answered(view, DOC);
    // q's source: no segment placed or unplaced reads it, only `go`'s env.
    expect([...view.lanes().sources.keys()]).toEqual(expect.arrayContaining([STATUS, DOC]));
    await writeUntilRead(view, DOC, SID, { home: "/h/other" });
    const { links, errors } = draw(view);
    expect(errors).toEqual([]);
    const link = runLink(links, "plugins.p.go");
    expect(link.sid).toBe(SID);
    expect(link.drawn).toEqual({
      run: ["./write.sh", SID],
      env: { HOME_VALUE: "/h/other" },
    });
    const declaration = declarationOf(view, link.name);
    expect(TEST_SIGNER.verify({ sessionId: link.sid, action: link.name, declaration, evaluated: link.evaluated }, link.mac)).toBe(
      true,
    );
  });

  test("a run bound by a computed name draws with the value of a source only its env reads", async () => {
    const r = rig();
    const view = viewOf(r, config(["plugins.p.computed"]));
    await answered(view, DOC);
    await writeUntilRead(view, DOC, SID, { home2: "/h/third" });
    const { links, errors } = draw(view);
    expect(errors).toEqual([]);
    expect(runLink(links, "plugins.p.go2").drawn.env).toEqual({ HOME_VALUE: "/h/third" });
  });
});

describe("a click on a run link", () => {
  async function drawnLink(r: Rig) {
    const view = viewOf(r, config(["plugins.p.shown", "plugins.p.go"]));
    await answered(view, DOC);
    await writeUntilRead(view, DOC, SID, { home: "/h/new" });
    return { view, link: runLink(draw(view).links, "plugins.p.go") };
  }

  // A link with one of its fields changed after it was signed.
  const relink = (l: { sid: string; name: string; evaluated: string; mac: string }) =>
    effectsUrl([{ verb: VERB_RUN, args: [l.sid, l.name, l.evaluated, l.mac] }]);

  test.each([
    ["the session", (l: ReturnType<typeof runLink>) => ({ ...l, sid: "s2" })],
    ["the action", (l: ReturnType<typeof runLink>) => ({ ...l, name: "plugins.p.go2" })],
    [
      "what was evaluated",
      (l: ReturnType<typeof runLink>) => ({ ...l, evaluated: l.evaluated.replace("./write.sh", "/bin/rm") }),
    ],
    ["the mac", (l: ReturnType<typeof runLink>) => ({ ...l, mac: `${l.mac.slice(0, -1)}${l.mac.endsWith("0") ? "1" : "0"}` })],
    ["the mac, with text after it", (l: ReturnType<typeof runLink>) => ({ ...l, mac: `${l.mac}00` })],
  ])("tampering with %s is refused into the session's bar, and nothing runs", async (_what, tamper) => {
    const r = rig();
    const { view, link } = await drawnLink(r);
    const tampered = tamper(link);
    const ctx = clickContext(r, view);
    // Another session that has rendered: what its link must prove is the
    // signature.
    r.sessionState.set("s2", SESSION_RENDER_ORIGIN_KEY, encodeRenderOrigin({ projectDir: dir, cwd: dir, target: { source: "search" } }));
    expect(() => clickUrl(relink(tampered), ctx)).toThrow(BadVerbArgs);
    expect(r.runs.stats()).toMatchObject({ started: 0, refused: 1 });
    expect(r.lines).toContainEqual(
      expect.stringMatching(
        new RegExp(`^warn run refused sid=${tampered.sid} action=${tampered.name.replace(/\./g, "\\.")} reason=".*signature does not match`),
      ),
    );
    // The refusal is in the bar of the session the link names.
    expect(lastClickError(r.sessionState, tampered.sid)?.text).toContain("signature does not match");
    expect(fs.existsSync(path.join(storage(), `${SID}.json`))).toBe(false);
  });

  test("a link naming a session that has never rendered is refused, and nothing runs", async () => {
    const r = rig();
    const { view, link } = await drawnLink(r);
    expect(() => clickUrl(relink({ ...link, sid: "s3" }), clickContext(r, view))).toThrow(
      "session s3 has not rendered yet — no config to act on",
    );
    expect(r.runs.stats()).toMatchObject({ started: 0, refused: 1 });
  });

  test("a link drawn before its action was edited is refused, and nothing runs", async () => {
    const r = rig();
    const { view, link } = await drawnLink(r);
    const { config: drawnUnder } = view.state;
    const decl = drawnUnder.actions[link.name] as RunAction;
    const edited = {
      ...drawnUnder,
      actions: { ...drawnUnder.actions, [link.name]: { ...decl, run: ["./other.sh", ...decl.run.slice(1)] } },
    } as typeof drawnUnder;
    const ctx = clickContext(r, view, { configFor: () => edited });
    expect(() => clickUrl(link.url, ctx)).toThrow(/its action has been edited since it was drawn/);
    expect(r.runs.stats()).toMatchObject({ started: 0, refused: 1 });
    // The same link under the declaration it was drawn from runs.
    clickUrl(link.url, clickContext(r, view));
    expect(r.runs.stats()).toMatchObject({ started: 1 });
  });

  test("a link signed with another key is refused", async () => {
    const r = rig();
    const { view, link } = await drawnLink(r);
    const ctx = clickContext(r, view, { links: linkSigner(Buffer.alloc(32, 9)) });
    expect(() => clickUrl(link.url, ctx)).toThrow(/signature does not match/);
    expect(r.runs.stats()).toMatchObject({ started: 0, refused: 1 });
  });

  test("a signed link naming no run the config declares is refused", async () => {
    const r = rig();
    const { view, link } = await drawnLink(r);
    for (const action of ["plugins.p.nope", "mine"]) {
      const forged = {
        ...link,
        name: action,
        mac: TEST_SIGNER.sign({ sessionId: SID, action, declaration: "[]", evaluated: link.evaluated }),
      };
      expect(() => clickUrl(relink(forged), clickContext(r, view))).toThrow(
        `"${action}" is not a run action this session's config declares`,
      );
    }
    expect(r.runs.stats()).toMatchObject({ started: 0, refused: 2 });
    expect(r.lines).toContainEqual(expect.stringContaining('run refused sid=s1 action=plugins.p.nope reason="\\"plugins.p.nope\\" is not a run action'));
  });

  test("the click returns with the program still running: the source draws its loading cell until the program exits, then its write", async () => {
    const program = heldLaunch();
    const r = rig(program.launch);
    const { view, link } = await drawnLink(r);
    await writeUntilRead(view, STATUS, SID, { home: "/h/old" });
    expect(draw(view).text).toContain("home=/h/old");

    clickUrl(link.url, clickContext(r, view));
    expect(r.runs.stats()).toMatchObject({ started: 1, running: 1 });
    // `superseded` is the state no request waits on
    // (test/render-payload-outcomes.test.ts).
    expect(view.lanes().sources.get(STATUS)!.current()).toMatchObject({ kind: "pending", why: "superseded" });
    const during = draw(view).text;
    expect(during).toContain(LOADING_GLYPH);
    expect(during).not.toContain("home=/h/old");

    programWrites(SID, { home: "/h/new" });
    program.exit();
    await until(() => draw(view).text.includes("home=/h/new"), "the program's write");
    expect(r.runs.stats()).toMatchObject({ started: 1, running: 0, failed: 0 });
    expect(lastClickError(r.sessionState, SID)).toBeNull();
  });

  test("the program runs in its declaring file's directory and sees the session, never the daemon", async () => {
    daemonSessionEnv();
    const r = rig();
    const { view, link } = await drawnLink(r);

    clickUrl(link.url, clickContext(r, view));
    await until(() => draw(view).text.includes("home=/h/new"), "the program's write", 10_000);
    const read = view.lanes().sources.get(STATUS)!.current();
    if (read.kind !== "ok") throw new Error(JSON.stringify(read));
    expect(read.value).toEqual({
      home: "/h/new",
      // The declaring file's directory, and the relative program resolved
      // there.
      cwd: path.join(dir, "p"),
      sid: SID,
      project: dir,
      config: "/u/.claude-x",
      tmux: "unset",
      pane: "unset",
    });
    expect(r.lines).toContainEqual(
      expect.stringMatching(/^info run sid=s1 action=plugins\.p\.go program=\.\/write\.sh outcome=ok exit=0 took=\d+ refreshed=plugins\.p\.status$/),
    );
  });
});

describe("the run owner", () => {
  const SESSION: SessionId = sessionIdOf(SID);
  const KEY: StorageKey = { folder: "/s", generation: 0 };

  // A run of `script` under /bin/sh, refreshing one source whose supersedes
  // and resumes are recorded.
  function owner(timeoutMs?: number) {
    const lines: string[] = [];
    const sessionState = new SessionState();
    const held: string[] = [];
    const runs = new Runs({
      supersede: (key, sid) => {
        held.push(`supersede ${key.folder} ${sid}`);
        return () => held.push(`resume ${key.folder} ${sid}`);
      },
      launch: processLauncher.launch,
      state: sessionState,
      log: (level, message) => lines.push(`${level} ${message}`),
      now: () => instantOf(new Date()),
      timeoutMs,
    });
    cleanups.push(() => runs.close());
    const run = (script: string): RunRequest => ({
      sessionId: SESSION,
      action: "act",
      argv: ["/bin/sh", "-c", script],
      env: sessionEnv(process.env, { sessionId: SID, projectDir: dir, claudeConfigDir: undefined }),
      cwd: dir,
      refreshes: [{ name: STATUS, storage: KEY }],
    });
    return { runs, lines, sessionState, held, run };
  }

  test("a non-zero exit puts the trimmed stderr in the session's bar, and counts as failed", async () => {
    const o = owner();
    o.runs.start(o.run(`echo "  it broke  " >&2; exit 3`));
    expect(o.held).toEqual([`supersede /s ${SID}`]);
    await until(() => o.runs.stats().running === 0, "the run's end");
    expect(lastClickError(o.sessionState, SID)?.text).toBe("run act: it broke");
    expect(o.held).toEqual([`supersede /s ${SID}`, `resume /s ${SID}`]);
    expect(o.runs.stats()).toMatchObject({ started: 1, failed: 1, timedOut: 0 });
    expect(o.lines).toContainEqual(
      expect.stringMatching(/^warn run sid=s1 action=act program=\/bin\/sh outcome=exit exit=3 took=\d+ refreshed=plugins\.p\.status$/),
    );
  });

  test("a non-zero exit that says nothing puts the reason in the bar", async () => {
    const o = owner();
    o.runs.start(o.run("exit 4"));
    await until(() => o.runs.stats().running === 0, "the run's end");
    expect(lastClickError(o.sessionState, SID)?.text).toBe("run act: exited 4");
  });

  test("a timeout puts the reason in the bar, resumes its sources, and counts as timed out", async () => {
    const o = owner(200);
    o.runs.start(o.run("sleep 5"));
    await until(() => o.runs.stats().running === 0, "the timeout");
    expect(lastClickError(o.sessionState, SID)?.text).toBe("run act: timed out after 0.2 s");
    expect(o.held).toContain(`resume /s ${SID}`);
    expect(o.runs.stats()).toMatchObject({ started: 1, failed: 0, timedOut: 1 });
    expect(o.lines).toContainEqual(expect.stringContaining("outcome=timeout"));
  });

  test("a program that cannot start puts why in the bar, and counts as failed", async () => {
    const o = owner();
    o.runs.start({ ...o.run(""), argv: ["./no-such-program"] });
    await until(() => o.runs.stats().running === 0, "the failed launch");
    expect(lastClickError(o.sessionState, SID)?.text).toMatch(/^run act: .*ENOENT/);
    expect(o.held).toContain(`resume /s ${SID}`);
    expect(o.runs.stats()).toMatchObject({ failed: 1 });
    expect(o.lines).toContainEqual(expect.stringContaining("program=./no-such-program outcome=launch exit=-"));
  });

  test("closing the owner aborts the run in flight and resumes its sources; nothing lands in the bar", async () => {
    const o = owner();
    o.runs.start(o.run("sleep 30"));
    expect(o.runs.stats().running).toBe(1);
    o.runs.close();
    await until(() => o.runs.stats().running === 0, "the aborted run's end");
    expect(o.held).toEqual([`supersede /s ${SID}`, `resume /s ${SID}`]);
    expect(o.lines).toContainEqual(expect.stringContaining("outcome=aborted"));
    expect(lastClickError(o.sessionState, SID)).toBeNull();
    expect(() => o.runs.start(o.run("true"))).toThrow("run owner used after close");
  });
});

describe("the session's process environment", () => {
  test("the daemon's session variables never reach it; the session's own are set from its facts", () => {
    const daemon = {
      PATH: "/usr/bin",
      CLAUDE_CODE_SESSION_ID: "daemon-sid",
      CLAUDE_PROJECT_DIR: "/daemon/project",
      CLAUDE_CONFIG_DIR: "/daemon/.claude",
      TMUX: "/tmp/tmux-501/default,1,0",
      TMUX_PANE: "%3",
    };
    expect(sessionEnv(daemon, { sessionId: "s9", projectDir: "/p", claudeConfigDir: "/u/.claude-z" })).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CODE_SESSION_ID: "s9",
      CLAUDE_PROJECT_DIR: "/p",
      CLAUDE_CONFIG_DIR: "/u/.claude-z",
    });
    // The default directory: the variable unset, as Claude Code reads it.
    expect(sessionEnv(daemon, { sessionId: "s9", projectDir: "/p", claudeConfigDir: undefined })).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CODE_SESSION_ID: "s9",
      CLAUDE_PROJECT_DIR: "/p",
    });
  });
});

describe("the link key", () => {
  test("is made once, 32 bytes readable by this user alone, and the same key across restarts", () => {
    const file = path.join(dir, "state", "link.key");
    const fields = { sessionId: SID, action: "a", declaration: "[]", evaluated: "{}" };
    const mac = linkSignerFromKeyFile(file).sign(fields);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file)).toHaveLength(32);
    // Another process over the same file verifies the first one's links.
    expect(linkSignerFromKeyFile(file).verify(fields, mac)).toBe(true);
    expect(linkSigner(TEST_LINK_KEY).verify(fields, mac)).toBe(false);
    // Each maker's own file is gone once the key landed.
    expect(fs.readdirSync(path.dirname(file))).toEqual(["link.key"]);
  });

  test("a maker that dies writing leaves no key, and the next one makes it whole", () => {
    const file = path.join(dir, "state", "link.key");
    const fields = { sessionId: SID, action: "a", declaration: "[]", evaluated: "{}" };
    const write = fs.writeFileSync;
    jest.spyOn(fs, "writeFileSync").mockImplementationOnce((target, data, opts) => {
      write(target, (data as Buffer).subarray(0, 3), opts as fs.WriteFileOptions);
      throw new Error("killed mid-write");
    });
    expect(() => linkSignerFromKeyFile(file).sign(fields)).toThrow("killed mid-write");
    expect(fs.existsSync(file)).toBe(false);
    jest.restoreAllMocks();
    linkSignerFromKeyFile(file).sign(fields);
    expect(fs.readFileSync(file)).toHaveLength(32);
  });

  test("a key already made is served from a state directory that cannot be written", () => {
    const file = path.join(dir, "state", "link.key");
    const fields = { sessionId: SID, action: "a", declaration: "[]", evaluated: "{}" };
    const mac = linkSignerFromKeyFile(file).sign(fields);
    fs.chmodSync(path.dirname(file), 0o500);
    try {
      expect(linkSignerFromKeyFile(file).verify(fields, mac)).toBe(true);
    } finally {
      fs.chmodSync(path.dirname(file), 0o700);
    }
  });

  test("a key file of the wrong length is refused, naming it", () => {
    const file = write("state/link.key", "short");
    expect(() => linkSignerFromKeyFile(file).sign({ sessionId: SID, action: "a", declaration: "[]", evaluated: "{}" })).toThrow(
      `link key ${file} holds 5 bytes, not 32`,
    );
  });
});
