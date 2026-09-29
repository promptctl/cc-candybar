// [LAW:verifiable-goals] brandon-context-ceiling-xta.asv: the `ceiling` segment
// and its controls, driven through the real loader, the real spine
// (registerDslConfig + renderDsl) and the real verb table, with a fake memento
// edge — plus the pure pieces (the plugin lookup, the reading parse, the
// payload projection) and the provider's cache. Memento's own behaviour
// (grammar, atomic write, read-back refusal) is driven for real in
// test/memento-integration.test.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { testVerbContext, effectsOf, clickUrl } from "./helpers/click";
import { VERB_CEILING } from "../src/click/wire";
import {
  VERBS,
  SESSION_RENDER_ORIGIN_KEY,
  encodeRenderOrigin,
} from "../src/daemon/verbs";
import { encodeSegments } from "../src/click/wire";
import {
  locateIn,
  parseReading,
  type CeilingMove,
  type CeilingReading,
  type CeilingScope,
  type MementoEdge,
} from "../src/memento/edge";
import { MementoProvider } from "../src/segments/memento";
import { projectMemento } from "../src/daemon/render-payload";
import { ABSENT, failed, ok, type Outcome } from "../src/utils/outcome";
import { linkUrls, stripAnsi } from "./helpers/ansi";

const ALLOWED = new Set(listResolvablePaletteNames());
const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};
const SCOPE: CeilingScope = {
  sessionId: "s1",
  projectDir: "/tmp/proj",
  cwd: "/tmp/proj/sub",
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-memento-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// ─── The segment, rendered and clicked ────────────────────────────────────────

function runtime(memento: Record<string, unknown> | undefined) {
  const config = parseAndValidate(
    "<user>",
    `{ globals: {}, root: { h: ['ceiling'] } }`,
    ALLOWED,
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  sessionState.set(
    "s1",
    SESSION_RENDER_ORIGIN_KEY,
    encodeRenderOrigin({ projectDir: "/tmp/proj", cwd: "/tmp/proj/sub", configFile: null }),
  );
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
  const payload = {
    session_id: "s1",
    workspace: { current_dir: "/tmp/proj/sub", project_dir: "/tmp/proj" },
    ...(memento !== undefined && { memento }),
  };
  const raw = (): string =>
    renderDsl(config, compiled, store, registry, payload, OPTS);
  const moves: { scope: CeilingScope; move: CeilingMove }[] = [];
  const logged: string[] = [];
  const ctx = {
    ...testVerbContext(sessionState, undefined, config),
    dlog: (_level: string, msg: string) => logged.push(msg),
    memento: { move: (scope: CeilingScope, move: CeilingMove) => moves.push({ scope, move }) },
  };
  return { raw, text: () => stripAnsi(raw()), ctx, moves, logged };
}

const ceilingUrls = (raw: string): string[] =>
  linkUrls(raw).filter((u) => effectsOf(u).some((e) => e.verb === VERB_CEILING));

describe("the ceiling segment", () => {
  test("memento absent: no cell", () => {
    expect(runtime(undefined).text()).not.toContain("⌈");
  });

  test("a ceiling in force: the count, with −, + and ∞; no ↺ without a session layer", () => {
    const rt = runtime({ ceiling: 350_000, off: false, session: "" });
    const text = rt.text();
    expect(text).toContain("⌈ 350.0K − + ∞");
    expect(text).not.toContain("↺");
    const moves = ceilingUrls(rt.raw()).map((u) => effectsOf(u)[0]!.args);
    expect(moves).toEqual([
      ["s1", "set", "-100_000"],
      ["s1", "set", "+100_000"],
      ["s1", "set", "off"],
    ]);
  });

  test("a session layer adds ↺, which clears it", () => {
    const rt = runtime({ ceiling: 450_000, off: false, session: "450000" });
    expect(rt.text()).toContain("⌈ 450.0K − + ∞ ↺");
    expect(ceilingUrls(rt.raw()).map((u) => effectsOf(u)[0]!.args).at(-1)).toEqual([
      "s1",
      "clear",
    ]);
  });

  test("off: says so, and offers only ↺ when this session turned it off", () => {
    const rt = runtime({ ceiling: 0, off: true, session: "off" });
    expect(rt.text()).toContain("⌈ off ↺");
    expect(rt.text()).not.toContain("+");
  });

  test("memento's refusal is shown in the cell, with the clear that can repair it", () => {
    const rt = runtime({ error: "memento config: /x/memento.conf line 2 sets 'ceilng'" });
    expect(rt.text()).toContain("⌈ ⚠ memento config: /x/memento.conf line 2 sets 'ceilng' ↺");
    const urls = ceilingUrls(rt.raw());
    expect(urls.map((u) => effectsOf(u)[0]!.args.slice(1))).toEqual([["clear"]]);
    clickUrl(urls[0]!, rt.ctx);
    expect(rt.moves.map((m) => m.move)).toEqual([{ kind: "clear" }]);
  });

  test("a click moves the session's layer, anchored where its render was", () => {
    const rt = runtime({ ceiling: 350_000, off: false, session: "" });
    const plus = ceilingUrls(rt.raw())[1]!;
    clickUrl(plus, rt.ctx);
    expect(rt.moves).toEqual([
      {
        scope: { sessionId: "s1", projectDir: "/tmp/proj", cwd: "/tmp/proj/sub" },
        move: { kind: "set", to: "+100_000" },
      },
    ]);
    // [LAW:nothing-unseen] The daemon log names the move and the session.
    expect(rt.logged).toContain("ceiling: set +100_000 (session=s1)");
  });

  test("a move the config does not declare is refused before memento sees it", () => {
    const rt = runtime({ ceiling: 350_000, off: false, session: "" });
    const handler = VERBS.get(VERB_CEILING)!;
    expect(() => handler(encodeSegments(["s1", "set", "5"]), rt.ctx)).toThrow(
      /"set 5" is not a move this config declares/,
    );
    expect(rt.moves).toEqual([]);
  });
});

// ─── The plugin lookup ────────────────────────────────────────────────────────

function plugin(name: string, withFiles = true): string {
  const root = path.join(dir, name);
  if (withFiles) {
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "skills", "ceiling", "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "lib", "ceiling_config.py"), "");
    fs.writeFileSync(path.join(root, "skills", "ceiling", "bin", "ceiling"), "");
  }
  return root;
}

function registry(plugins: unknown): string {
  const file = path.join(dir, "installed_plugins.json");
  fs.writeFileSync(file, JSON.stringify({ version: 2, plugins }));
  return file;
}

describe("locateIn", () => {
  test("no registry file, or no memento in it: absent", () => {
    expect(locateIn(path.join(dir, "none.json"), "/p")).toEqual(ABSENT);
    const other = plugin("other");
    expect(
      locateIn(registry({ "memento-dev@x": [{ scope: "user", installPath: other }] }), "/p"),
    ).toEqual(ABSENT);
  });

  test("a user install is found; a project install for this project wins over it", () => {
    const user = plugin("user");
    const proj = plugin("proj");
    const file = registry({
      "memento@memento": [
        { scope: "user", installPath: user },
        { scope: "local", installPath: proj, projectPath: "/p" },
      ],
    });
    expect(locateIn(file, "/p")).toEqual(ok(proj));
    expect(locateIn(file, "/elsewhere")).toEqual(ok(user));
  });

  test("a project install for another project only: absent", () => {
    const file = registry({
      "memento@m": [{ scope: "local", installPath: plugin("p"), projectPath: "/other" }],
    });
    expect(locateIn(file, "/p")).toEqual(ABSENT);
  });

  test("an install without the ceiling files fails, naming what is missing", () => {
    const bare = plugin("old", false);
    const out = locateIn(registry({ "memento@m": [{ scope: "user", installPath: bare }] }), "/p");
    expect(out.kind).toBe("failed");
    expect((out as { reason: string }).reason).toContain("lib/ceiling_config.py");
  });

  test("disabled in Claude Code's settings: absent; the project-local layer wins", () => {
    const user = plugin("user");
    // Claude Code's layout: settings.json beside plugins/installed_plugins.json.
    const file = path.join(dir, "plugins", "installed_plugins.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(
      file,
      JSON.stringify({ plugins: { "memento@memento": [{ scope: "user", installPath: user }] } }),
    );
    const project = path.join(dir, "proj");
    fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
    const settings = (f: string, enabled: boolean) =>
      fs.writeFileSync(f, JSON.stringify({ enabledPlugins: { "memento@memento": enabled } }));
    settings(path.join(dir, "settings.json"), false);
    expect(locateIn(file, project)).toEqual(ABSENT);
    settings(path.join(project, ".claude", "settings.local.json"), true);
    expect(locateIn(file, project)).toEqual(ok(user));
    settings(path.join(project, ".claude", "settings.local.json"), false);
    settings(path.join(dir, "settings.json"), true);
    expect(locateIn(file, project)).toEqual(ABSENT);
    fs.writeFileSync(path.join(project, ".claude", "settings.json"), "{ nope");
    expect(locateIn(file, project).kind).toBe("failed");
  });

  test("a registry that is not the expected shape fails, naming the file", () => {
    const file = path.join(dir, "installed_plugins.json");
    fs.writeFileSync(file, "{ nope");
    expect(locateIn(file, "/p").kind).toBe("failed");
    fs.writeFileSync(file, JSON.stringify({ plugins: { "memento@m": {} } }));
    expect(locateIn(file, "/p")).toEqual(
      failed(`memento lookup: ${file}: "memento@m" is not a list of installs`),
    );
  });
});

// ─── The reading and its projection ───────────────────────────────────────────

describe("parseReading / projectMemento", () => {
  test("a count, off, and a session layer cross as a reading", () => {
    expect(parseReading('{"ceiling": 350000, "session": null}')).toEqual(
      ok({ ceiling: 350000, session: null }),
    );
    expect(parseReading('{"ceiling": "off", "session": "off"}')).toEqual(
      ok({ ceiling: "off", session: "off" }),
    );
  });

  test("anything else fails loudly", () => {
    expect(parseReading("Traceback").kind).toBe("failed");
    expect(parseReading('{"ceiling": -1, "session": null}').kind).toBe("failed");
    expect(parseReading('{"ceiling": 1, "session": 3}').kind).toBe("failed");
  });

  test("the payload: absent drops the family, failed carries the reason", () => {
    expect(projectMemento(ABSENT)).toBeUndefined();
    expect(projectMemento(failed("bad line"))).toEqual({ error: "bad line" });
    // One bar row: a traceback projects the line naming the fault.
    expect(
      projectMemento(
        failed('Traceback (most recent call last):\n  File "<string>", line 4\nImportError: cannot import name \'ceiling_in\'\n'),
      ),
    ).toEqual({ error: "ImportError: cannot import name 'ceiling_in'" });
    expect(projectMemento(ok({ ceiling: "off", session: null }))).toEqual({
      ceiling: 0,
      off: true,
      session: "",
    });
  });
});

// ─── The provider's cache ─────────────────────────────────────────────────────

function fakeEdge(readings: Outcome<CeilingReading>[]) {
  const reads: CeilingScope[] = [];
  const moves: CeilingMove[] = [];
  let pending: ((o: Outcome<CeilingReading>) => void) | undefined;
  let hold = false;
  const edge: MementoEdge = {
    locate: () => ok("/plugin"),
    read: (_root, scope) => {
      reads.push(scope);
      const next = readings.shift()!;
      if (!hold) return Promise.resolve(next);
      hold = false; // holds the one read that follows holdReads()
      return new Promise((resolve) => (pending = () => resolve(next)));
    },
    move: (_root, _scope, m) => {
      moves.push(m);
    },
  };
  return {
    edge,
    reads,
    moves,
    holdReads: () => (hold = true),
    release: () => pending!(ABSENT),
  };
}

describe("MementoProvider", () => {
  const A = ok({ ceiling: 350_000, session: null });
  const B = ok({ ceiling: 450_000, session: "450000" });

  test("a reading stands for its TTL; past it, it is drawn while memento is asked again", async () => {
    let now = 0;
    const f = fakeEdge([A, B]);
    const p = new MementoProvider(f.edge, () => now);
    expect(await p.getCeiling(SCOPE)).toEqual(A);
    now = 9_999;
    expect(await p.getCeiling(SCOPE)).toEqual(A);
    expect(f.reads).toHaveLength(1);
    now = 10_000;
    // The render does not wait on the spawn: it draws the expired reading.
    expect(await p.getCeiling(SCOPE)).toEqual(A);
    expect(f.reads).toHaveLength(2);
    expect(await p.getCeiling(SCOPE)).toEqual(B);
    expect(f.reads).toHaveLength(2);
  });

  test("a move drops the reading, so the next render reads what it left", async () => {
    const f = fakeEdge([A, B]);
    const p = new MementoProvider(f.edge, () => 0);
    await p.getCeiling(SCOPE);
    p.move(SCOPE, { kind: "set", to: "+100_000" });
    expect(f.moves).toEqual([{ kind: "set", to: "+100_000" }]);
    // The click already asked memento; the render joins that read.
    expect(f.reads).toHaveLength(2);
    expect(await p.getCeiling(SCOPE)).toEqual(B);
    expect(f.reads).toHaveLength(2);
  });

  test("a read in flight when a move lands is not cached", async () => {
    const f = fakeEdge([A, B]);
    const p = new MementoProvider(f.edge, () => 0);
    f.holdReads();
    const stale = p.getCeiling(SCOPE);
    p.move(SCOPE, { kind: "clear" });
    f.release();
    await stale;
    // Not served from the stale read: memento is asked afresh.
    await p.getCeiling(SCOPE);
    expect(f.reads).toHaveLength(2);
  });

  test("memento not installed: the reading is absent and a move refuses", async () => {
    const edge: MementoEdge = {
      locate: () => ABSENT,
      read: () => {
        throw new Error("unreachable");
      },
      move: () => {
        throw new Error("unreachable");
      },
    };
    const p = new MementoProvider(edge, () => 0);
    expect(await p.getCeiling(SCOPE)).toEqual(ABSENT);
    expect(() => p.move(SCOPE, { kind: "clear" })).toThrow(/not installed/);
  });
});
