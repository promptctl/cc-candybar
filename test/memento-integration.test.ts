// [LAW:verifiable-goals] brandon-context-ceiling-xta.asv against the REAL
// memento plugin: the edge reads through memento's own module and moves through
// its own `ceiling` command, in a temp MEMENTO_CONFIG_HOME so no real layer is
// touched. Runs where memento is installed for this user (Claude Code's plugin
// registry names it); a machine without memento has nothing to drive, and says
// so in the suite name rather than passing vacuously.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  locateIn,
  productionMementoEdge,
  type CeilingScope,
} from "../src/memento/edge";
import { launchSync } from "../src/proc/launch";

// The host's own registry, read past test/setup.ts's CLAUDE_CONFIG_DIR, which
// hides it from every test daemon.
const HOST_CLAUDE_DIR = path.join(os.homedir(), ".claude");
const located = locateIn(
  path.join(HOST_CLAUDE_DIR, "plugins", "installed_plugins.json"),
  "/nonexistent-project",
);
const root = located.kind === "ok" ? located.value : undefined;
const suite = root ? describe : describe.skip;

suite(`memento at ${root ?? "(not installed — skipped)"}`, () => {
  const edge = productionMementoEdge();
  let home: string;
  let project: string;
  let scope: CeilingScope;
  let saved: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-memento-home-"));
    project = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-memento-proj-"));
    // The process's own variable plays the detached daemon's: another
    // session's config home, which the scope's reported one must replace.
    saved = process.env.MEMENTO_CONFIG_HOME;
    process.env.MEMENTO_CONFIG_HOME = path.join(home, "the-daemons-own");
    scope = {
      sessionId: "ccb-test-session",
      projectDir: project,
      cwd: project,
      claudeConfigDir: HOST_CLAUDE_DIR,
      env: { MEMENTO_CONFIG_HOME: home },
    };
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MEMENTO_CONFIG_HOME;
    else process.env.MEMENTO_CONFIG_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const sessionFile = (): string =>
    path.join(home, "sessions", scope.sessionId, "memento.conf");

  const reading = async () => {
    const out = await edge.read(root!, scope);
    if (out.kind !== "ok") throw new Error(`read: ${JSON.stringify(out)}`);
    return out.value;
  };

  // Memento's own report, the way a person confirms a move.
  const show = (): string => {
    const r = launchSync({
      bin: path.join(root!, "skills", "ceiling", "bin", "ceiling"),
      args: ["show"],
      cwd: project,
      env: {
        ...process.env,
        MEMENTO_CONFIG_HOME: home,
        CLAUDE_CODE_SESSION_ID: scope.sessionId,
        CLAUDE_PROJECT_DIR: project,
      },
      category: "memento.move",
    });
    if (!r.ok) throw new Error(`ceiling show: ${r.stderr}`);
    return r.stdout;
  };

  test("the edge finds the host's memento through the scope's Claude Code directory", () => {
    expect(edge.locate(scope)).toEqual({ kind: "ok", value: root });
  });

  test("raise, lower, off and clear land in the session layer, as memento reports them", async () => {
    const base = await reading();
    expect(base.session).toBeNull();
    expect(typeof base.ceiling).toBe("number");
    const start = base.ceiling as number;

    edge.move(root!, scope, { kind: "set", to: "+100_000" });
    expect(await reading()).toEqual({
      ceiling: start + 100_000,
      session: String(start + 100_000),
    });
    expect(show()).toMatch(
      new RegExp(`this session\\s+${(start + 100_000).toLocaleString("en-US")} tokens`),
    );

    edge.move(root!, scope, { kind: "set", to: "-50_000" });
    expect((await reading()).ceiling).toBe(start + 50_000);

    edge.move(root!, scope, { kind: "set", to: "off" });
    expect(await reading()).toEqual({ ceiling: "off", session: "off" });
    expect(show()).toMatch(/this session\s+no ceiling/);

    edge.move(root!, scope, { kind: "clear" });
    expect(await reading()).toEqual({ ceiling: start, session: null });
    expect(fs.existsSync(sessionFile())).toBe(false);
  });

  test("a value memento refuses leaves the layer's bytes as they were, and says why", async () => {
    edge.move(root!, scope, { kind: "set", to: "400000" });
    const before = fs.readFileSync(sessionFile(), "utf8");
    expect(() => edge.move(root!, scope, { kind: "set", to: "100k" })).toThrow(
      /100k/,
    );
    expect(fs.readFileSync(sessionFile(), "utf8")).toBe(before);
    expect((await reading()).ceiling).toBe(400_000);
  });

  test("a working directory removed since (a deleted worktree) reads and moves as before", async () => {
    const gone = path.join(project, "worktree");
    const moved = { ...scope, cwd: gone };
    edge.move(root!, moved, { kind: "set", to: "400000" });
    const out = await edge.read(root!, moved);
    expect(out).toEqual({ kind: "ok", value: { ceiling: 400_000, session: "400000" } });
  });

  test("a layer memento cannot read is a failed reading naming the file", async () => {
    fs.mkdirSync(path.dirname(sessionFile()), { recursive: true });
    fs.writeFileSync(sessionFile(), "ceilng = 5\n");
    const out = await edge.read(root!, scope);
    expect(out.kind).toBe("failed");
    expect((out as { reason: string }).reason).toContain(sessionFile());
  });

  test("a session move leaves the user's own layer, comments and all, untouched", async () => {
    const user = path.join(home, "memento.conf");
    const text = "# my ceiling\nceiling = 300_000  # roomy\n";
    fs.writeFileSync(user, text);
    expect((await reading()).ceiling).toBe(300_000);
    edge.move(root!, scope, { kind: "set", to: "+100_000" });
    expect((await reading()).ceiling).toBe(400_000);
    expect(fs.readFileSync(user, "utf8")).toBe(text);
  });
});
