// [LAW:behavior-not-structure] A repository's cc-candybar configs — its project
// and local layers and its `.cc-candybar/plugins/` — load only once the user
// approved the repository, and every resolution (the render and the durable writer) answers the same way. The answer is per repository, holds
// across edits (nothing here hashes a file) and covers every linked worktree.

import { writeStatePlan } from "./helpers/state-file";
import { bareGates } from "./helpers/gates";
import { HOST, hostOf } from "../scripts/lib/host";
import { worldOf } from "./helpers/host";
import type { Host, World } from "../src/host";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderConfig } from "./helpers/config-fixture";
import { configResolutionNotice } from "../src/config/dsl-loader";
import { resolutionOf } from "./helpers/config-search";
import {
  repoUnreadNotice,
  type RepoAnswers,
} from "../src/config/loader/repo-gate";
import {
  chainPlaces,
  configLocations,
} from "../src/config/loader/chain-places";
import {
  configLoadedLine,
  type LoadCause,
  type ReloadedEntry,
} from "../src/renderer/render-cache";
import {
  answeredBook,
  repoConfigs,
  repoConfigsPath,
} from "../src/daemon/config-discovery/repo-configs";
import { readTextIfPresent } from "../src/utils/regular-text";
import { repoQuestions } from "../src/config/repo-question";
import { SessionState } from "../src/renderer/session-state";
import { answerRepo, recordAnswer } from "./helpers/repo-approval";
import { locations, stateDir } from "../src/daemon/paths";
import { systemTimekeeper } from "../scripts/lib/system-clock";
import { SourceRuns } from "../src/daemon/source-runs";

import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { loadDiscovered, originOf } from "./helpers/config-host";
import { revisionOf, type ConfigSnapshot } from "../src/config/config-snapshot";

const SID_1 = sessionIdOf("sid-1");

let root: string;
let project: string;
let host: Host;
let world: World;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-repo-gate-")),
  );
  project = path.join(root, "repo");
  fs.mkdirSync(project);
  host = hostOf({ ...HOST.env, XDG_CONFIG_HOME: path.join(root, "xdg") });
  world = worldOf(host);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const book = (value: Record<string, "approved" | "declined">): RepoAnswers => ({
  kind: "ok",
  value,
});

function write(rel: string, text: string): string {
  const file = path.join(project, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const layersOf = (answers: RepoAnswers) => {
  const r = resolutionOf(locations(host), answers, { projectDir: project });
  return r.kind === "chain" ? r.layers.map((l) => l.path) : null;
};

describe("the gate over a project's config file", () => {
  test("unanswered, it is no layer, and the gate names the directory awaiting", () => {
    const file = write(".cc-candybar.json5", "{}");
    const resolved = resolutionOf(locations(host), book({}), {
      projectDir: project,
    });
    expect(layersOf(book({}))).toEqual([]);
    expect(resolved.project.question).toEqual({
      dir: project,
      standing: "awaiting",
      unproven: null,
    });
    expect(layersOf(book({ [project]: "approved" }))).toEqual([file]);
  });

  test("declined, it is no layer and nothing awaits", () => {
    write(".cc-candybar.json5", "{}");
    const resolved = resolutionOf(
      locations(host),
      book({ [project]: "declined" }),
      { projectDir: project },
    );
    expect(resolved.kind === "chain" && resolved.layers).toEqual([]);
    expect(resolved.project.question).toMatchObject({
      dir: project,
      standing: "declined",
    });
  });

  test("an explicit base is trusted, and other project layers still need approval", () => {
    const user = path.join(root, "xdg", "cc-candybar", "config.json5");
    fs.mkdirSync(path.dirname(user), { recursive: true });
    fs.writeFileSync(user, "{}");
    expect(layersOf(book({}))).toEqual([user]);
    const named = write("named.json5", "{}");
    write(".cc-candybar.json5", "{}");
    const explicit = resolutionOf(locations(host), book({}), {
      projectDir: project,
      configFile: named,
    });
    // An explicit file is the user's, whatever repository it sits in.
    expect(explicit.kind === "chain" && explicit.layers).toEqual([
      { path: named, role: "user" },
    ]);
    expect(explicit.project.question).toMatchObject({
      dir: project,
      standing: "awaiting",
    });
  });

  test("the chain a click writes leaves out what the bar's leaves out", () => {
    write(".cc-candybar.json5", "{}");
    const query = { kind: "chain", projectDir: project } as const;
    expect(
      chainPlaces(
        resolutionOf(locations(host), book({}), query),
        configLocations(locations(host), query),
      ),
    ).toEqual([{ path: expect.any(String), role: "user" }]);
  });

  test("a book that cannot be read answers for nobody, asks again, and says so", () => {
    write(".cc-candybar.json5", "{}");
    const resolved = resolutionOf(
      locations(host),
      { kind: "failed", reason: "repo-configs.json is not JSON" },
      { projectDir: project },
    );
    expect(resolved.kind === "chain" && resolved.layers).toEqual([]);
    // The answer's write sets the unread book aside, so the bar can record
    // it, and the notice says what that write will do.
    expect(resolved.project.question?.standing).toBe("awaiting");
    expect(repoUnreadNotice(resolved.project)?.message).toContain(
      "repo-configs.json is not JSON",
    );
    expect(repoUnreadNotice(resolved.project)?.message).toContain(
      "the next answer sets the unread book aside beside itself",
    );
    // The bar's search notice stays about the search.
    expect(configResolutionNotice(resolved)).toBeNull();
  });
});

describe("the gate over a project's plugins", () => {
  const PLUGIN = `{ segments: { status: { template: "PLUGSEG" } } }`;

  test("a plugin folder awaits the directory's answer, and loads once approved", () => {
    write(".cc-candybar/plugins/deploy/plugin.json5", PLUGIN);
    const deps = {
      clock: systemTimekeeper,
      sessionState: new SessionState(),
      gates: bareGates(),
      stateDir: stateDir(host),
      locations: locations(host),
      env: host.env,
    };
    const waiting = loadDiscovered(project, project, undefined, deps);
    expect(waiting.snapshot.repo).toEqual({
      dir: project,
      standing: "awaiting",
      unproven: null,
    });
    expect(waiting.state!.plugins.loaded).toEqual([]);
    waiting.state!.registry.dispose();

    answerRepo(project);
    const approved = loadDiscovered(project, project, undefined, deps);
    expect(approved.snapshot.repo).toEqual({
      dir: project,
      standing: "approved",
      unproven: null,
    });
    expect(approved.state!.plugins.loaded).toEqual([
      {
        path: path.join(project, ".cc-candybar/plugins/deploy/plugin.json5"),
        scope: "repo",
        name: "deploy",
      },
    ]);
    approved.state!.registry.dispose();
  });

  test("an empty plugin folder has nothing to ask about", () => {
    fs.mkdirSync(path.join(project, ".cc-candybar/plugins"), {
      recursive: true,
    });
    expect(
      resolutionOf(locations(host), book({}), { projectDir: project }).project
        .question,
    ).toBeNull();
  });
});

describe("check", () => {
  // A config whose variable runs a program as soon as it loads.
  const shellConfig = (marker: string): string =>
    JSON.stringify({
      variables: {
        ran: {
          kind: "shell",
          command: `touch ${marker}; echo ran`,
          parse: { text: true },
          cache: { never: true },
          default: "",
        },
      },
      segments: { repo: { template: "R{{ .ran }}" } },
      root: { h: ["repo"] },
    });

  test("an unanswered project config is reported awaiting, and nothing of it runs", async () => {
    const marker = path.join(project, "ran.marker");
    write(".cc-candybar.json5", shellConfig(marker));
    const outcome = await renderConfig(world, undefined, project);
    expect(outcome.kind).toBe("clean");
    if (outcome.kind !== "clean") return;
    expect(outcome.layers).toEqual([]);
    expect(outcome.warnings).toContain(
      `awaiting approval: ${project} — its cc-candybar config runs once it is approved in the bar`,
    );
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("an approved one loads and runs", async () => {
    const marker = path.join(project, "ran.marker");
    const file = write(".cc-candybar.json5", shellConfig(marker));
    answerRepo(project);
    const outcome = await renderConfig(world, undefined, project);
    expect(outcome).toMatchObject({
      kind: "clean",
      layers: [{ path: file, role: "project" }],
    });
    expect(fs.existsSync(marker)).toBe(true);
  });

  test("a directory whose worktree claim fails its proof is reported with the reason it answers for itself", async () => {
    write(".cc-candybar.json5", "{}");
    write(".git", "gitdir: /nonexistent/x\n");
    const outcome = await renderConfig(world, undefined, project);
    expect(outcome.kind).toBe("clean");
    if (outcome.kind !== "clean") return;
    expect(outcome.warnings).toContain(
      `not proven a worktree: ${project} — it answers for itself, because /nonexistent/x is not there`,
    );
  });
});

const NO_SNAPSHOT: ConfigSnapshot = {
  chain: [],
  repo: null,
  plugins: [],
  strays: [],
  checkout: { root: "/p", git: false },
  notices: [],
  watch: null,
};

const loadedEntry: ReloadedEntry = {
  origin: originOf("/p", "/p", undefined),
  configLayers: [],
  revision: revisionOf(NO_SNAPSHOT),
  lastError: null,
  lastWarnings: [],
  state: undefined as never,
};

test.each<[LoadCause, string]>([
  [{ kind: "open" }, "open"],
  [{ kind: "config" }, "config"],
])("the config loaded event says why the load ran: %j", (cause, field) => {
  expect(configLoadedLine(loadedEntry, cause, "built")).toContain(
    ` cwd=/p cause=${field} state=built files=`,
  );
});

test("the config loaded event names the repository's standing, and why its worktree is unproven", () => {
  const entry: ReloadedEntry = {
    ...loadedEntry,
    origin: originOf(project, project, undefined),
    revision: revisionOf({
      ...NO_SNAPSHOT,
      repo: { dir: "/a", standing: "awaiting", unproven: "/x is not there" },
    }),
  };
  const line = configLoadedLine(entry, { kind: "open" }, "built");
  expect(line).toContain(` repo=awaiting:/a unproven="/x is not there" `);
});

test("the question captures its session, directory and decision on each answer", () => {
  const [channel, ...rest] = repoQuestions(
    { dir: project, standing: "awaiting", unproven: null },
    SID_1,
  );
  expect(rest).toEqual([]);
  expect(channel!.message).toBe(
    `a cc-candybar config for ${project} — run it?`,
  );
  expect(
    channel!.lines[0].flatMap(({ link }) => (link === null ? [] : [link])),
  ).toEqual([
    { kind: "repo-answer", session: SID_1, dir: project, answer: "approved" },
    { kind: "repo-answer", session: SID_1, dir: project, answer: "declined" },
  ]);
});

// An answer kept where the book used to live, directly in the state
// directory, still holds once the book has a folder of its own.
describe("the book in the state directory", () => {
  const state = (): string => path.join(root, "state");
  const loose = (): string => path.join(state(), "repo-configs.json");
  const other = (): string => path.join(root, "other");
  const write = (file: string, book: object): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(book));
  };

  test("is read while the folder holds no book", () => {
    write(loose(), { [project]: "approved" });
    expect(repoConfigs(state()).read()).toEqual({
      kind: "ok",
      value: { [project]: "approved" },
    });
  });

  test.each([true, false])(
    "an exact project key keeps the existing decision in either order (%s)",
    (exactFirst) => {
      const exact = [project, "declined"];
      const alias = [project + path.sep, "approved"];
      write(
        loose(),
        Object.fromEntries(exactFirst ? [exact, alias] : [alias, exact]),
      );
      expect(repoConfigs(state()).read()).toEqual(
        book({ [project]: "declined" }),
      );
    },
  );

  test("equivalent entries with the same decision give one project key", () => {
    const filesystemRoot = path.parse(project).root;
    write(loose(), {
      [project + "/."]: "approved",
      [project + "//"]: "approved",
      [filesystemRoot]: "declined",
    });
    expect(repoConfigs(state()).read()).toEqual(
      book({ [project]: "approved", [filesystemRoot]: "declined" }),
    );
  });

  test.each([
    ["relative directory", { "relative/project": "approved" }],
    ["parent component", { [project + "/child/../"]: "approved" }],
    [
      "conflicting aliases",
      { [project + "/"]: "approved", [project + "//"]: "declined" },
    ],
  ])(
    "an update sets the stored bytes aside when the answer file has %s",
    (_name, entries) => {
      write(loose(), entries);
      const before = fs.readFileSync(loose(), "utf8");
      const store = repoConfigs(state());
      expect(store.read()).toMatchObject({
        kind: "failed",
        reason: expect.stringContaining(loose()),
      });
      const planned = store.plan((book) => ({
        ...book,
        [other()]: "declined",
      }));
      expect(writeStatePlan(planned)).toEqual({
        kind: "ok",
        value: { [other()]: "declined" },
      });
      const aside = planned.kind === "ok" ? planned.value.setAside : null;
      expect(aside?.from).toBe(loose());
      expect(fs.readFileSync(aside!.to, "utf8")).toBe(before);
      expect(fs.existsSync(loose())).toBe(false);
      expect(store.read()).toEqual({
        kind: "ok",
        value: { [other()]: "declined" },
      });
    },
  );

  test("the first answer recorded writes it into the folder, with the answer", () => {
    write(loose(), { [project]: "approved" });
    writeStatePlan(
      repoConfigs(state()).plan((book) => ({ ...book, [other()]: "declined" })),
    );
    const filed = {
      kind: "ok",
      value: { [project]: "approved", [other()]: "declined" },
    };
    expect(repoConfigs(state()).read()).toEqual(filed);
    expect(
      JSON.parse(fs.readFileSync(repoConfigsPath(state()), "utf8")),
    ).toEqual(filed.value);
  });

  test("retiring an imported symlink leaves its target and makes a deliberate reset stick", () => {
    const external = path.join(root, "archived-answers.json");
    write(external, { [project]: "approved" });
    fs.mkdirSync(state());
    fs.symlinkSync(external, loose());
    const store = repoConfigs(state());
    writeStatePlan(store.plan((book) => ({ ...book, [other()]: "declined" })));
    expect(fs.lstatSync(loose(), { throwIfNoEntry: false })).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(external, "utf8"))).toEqual({
      [project]: "approved",
    });
    fs.unlinkSync(repoConfigsPath(state()));
    expect(store.read()).toEqual({ kind: "ok", value: {} });
  });

  test("an explicit write retires the leftover loose copy from an earlier upgrade", () => {
    write(loose(), { [project]: "approved" });
    write(repoConfigsPath(state()), { [project]: "declined" });
    const store = repoConfigs(state());
    expect(store.read()).toEqual({
      kind: "ok",
      value: { [project]: "declined" },
    });
    expect(fs.existsSync(loose())).toBe(true);
    writeStatePlan(store.plan((book) => ({ ...book, [other()]: "approved" })));
    const backups = fs
      .readdirSync(state())
      .filter((name) => name.startsWith("repo-configs.json.migrated-"));
    expect(backups).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(state(), backups[0]!), "utf8")),
    ).toEqual({ [project]: "approved" });
    fs.unlinkSync(repoConfigsPath(state()));
    expect(store.read()).toEqual({ kind: "ok", value: {} });
  });

  test("a dangling legacy link cannot revive an answer after the current book is reset", () => {
    fs.mkdirSync(state());
    const target = path.join(root, "offline-answers.json");
    fs.symlinkSync(target, loose());
    const store = repoConfigs(state());
    writeStatePlan(store.plan(() => ({ [project]: "declined" })));
    expect(fs.lstatSync(loose(), { throwIfNoEntry: false })).toBeUndefined();
    write(target, { [project]: "approved" });
    fs.unlinkSync(repoConfigsPath(state()));
    expect(store.read()).toEqual({ kind: "ok", value: {} });
  });

  test("a current book explicitly linked to the older name keeps its backing file", () => {
    write(loose(), { [project]: "approved" });
    fs.mkdirSync(path.dirname(repoConfigsPath(state())));
    fs.symlinkSync(loose(), repoConfigsPath(state()));
    const store = repoConfigs(state());
    writeStatePlan(store.plan((book) => ({ ...book, [other()]: "declined" })));
    expect(store.read()).toEqual({
      kind: "ok",
      value: { [project]: "approved", [other()]: "declined" },
    });
    expect(fs.lstatSync(repoConfigsPath(state())).isSymbolicLink()).toBe(true);
  });

  test("is not read once the folder holds a book", () => {
    write(loose(), { [project]: "approved" });
    write(repoConfigsPath(state()), { [project]: "declined" });
    expect(repoConfigs(state()).read()).toEqual({
      kind: "ok",
      value: { [project]: "declined" },
    });
  });

  test("a failure reaching the current book is reported by a read, and an update writes nothing", () => {
    write(loose(), { [project]: "approved" });
    fs.writeFileSync(path.dirname(repoConfigsPath(state())), "ordinary file");
    const store = repoConfigs(state());
    expect(store.read()).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("ENOTDIR"),
    });
    // Setting aside what cannot be reached fails too, so nothing is written.
    expect(() => writeStatePlan(store.plan(() => ({})))).toThrow(/ENOTDIR/);
    expect(JSON.parse(fs.readFileSync(loose(), "utf8"))).toEqual({
      [project]: "approved",
    });
  });
});

describe("a repository's worktrees answer as the repository", () => {
  let wt: string;
  const git = (...args: string[]): void => {
    execFileSync("git", args, { stdio: "ignore" });
  };
  const resolveAt = (answers: RepoAnswers, dir: string) =>
    resolutionOf(locations(host), answers, { projectDir: dir });
  const layersAt = (answers: RepoAnswers, dir: string) => {
    const r = resolveAt(answers, dir);
    return r.kind === "chain" ? r.layers.map((l) => l.path) : null;
  };

  beforeEach(() => {
    git("init", "-q", project);
    git(
      "-C",
      project,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "c",
    );
    wt = path.join(root, "wt");
    git("-C", project, "worktree", "add", "-q", "--detach", wt);
    fs.writeFileSync(path.join(wt, ".cc-candybar.json5"), "{}");
    fs.mkdirSync(path.join(wt, ".cc-candybar/plugins/deploy"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(wt, ".cc-candybar/plugins/deploy/plugin.json5"),
      "{}",
    );
  });

  test("a new worktree of an approved repository loads its config and plugins, and never asks", () => {
    const resolved = resolveAt(book({ [project]: "approved" }), wt);
    expect(resolved).toMatchObject({
      layers: [{ path: path.join(wt, ".cc-candybar.json5"), role: "project" }],
      project: {
        approved: wt,
        question: { dir: project, standing: "approved" },
      },
    });
  });

  test.each(["approved", "declined"] as const)(
    "a stored %s decision covers the same project with or without its trailing separator",
    (decision) => {
      write(".cc-candybar.json5", "{}");
      const state = path.join(root, "answers");
      const file = repoConfigsPath(state);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const raw = JSON.stringify({ [project + path.sep]: decision });
      fs.writeFileSync(file, raw);
      const stored = repoConfigs(state).read();
      for (const dir of [project, wt]) {
        expect(resolveAt(stored, dir).project.question).toMatchObject({
          dir: project,
          standing: decision,
        });
        expect(layersAt(stored, dir)).toEqual(
          decision === "approved" ? [path.join(dir, ".cc-candybar.json5")] : [],
        );
      }
      expect(fs.readFileSync(file, "utf8")).toBe(raw);
      const answer = decision === "approved" ? "declined" : "approved";
      const change = answeredBook(
        state,
        [{ session: SID_1, dir: project, answer }],
        readTextIfPresent,
      );
      expect(writeStatePlan(change)).toEqual(book({ [project]: answer }));
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
        [project]: answer,
      });
    },
  );

  test("a worktree's own answer stands while its repository has none", () => {
    expect(resolveAt(book({ [wt]: "approved" }), wt)).toMatchObject({
      layers: [{ path: path.join(wt, ".cc-candybar.json5"), role: "project" }],
      project: { approved: wt, question: { dir: wt, standing: "approved" } },
    });
    expect(resolveAt(book({ [wt]: "declined" }), wt)).toMatchObject({
      layers: [],
      project: { approved: null, question: { dir: wt, standing: "declined" } },
    });
  });

  test("a declined repository's worktrees are declined", () => {
    const resolved = resolveAt(book({ [project]: "declined" }), wt);
    expect(resolved).toMatchObject({
      layers: [],
      project: {
        approved: null,
        question: { dir: project, standing: "declined" },
      },
    });
  });

  test("an unanswered repository's worktree asks for the repository, and its answer covers both", () => {
    expect(resolveAt(book({}), wt).project.question).toMatchObject({
      dir: project,
      standing: "awaiting",
    });
    const state = repoConfigs(path.join(root, "state"));
    expect(recordAnswer(state, project, "approved").kind).toBe("ok");
    const answers = state.read() as RepoAnswers;
    expect(layersAt(answers, wt)).toEqual([
      path.join(wt, ".cc-candybar.json5"),
    ]);
    fs.writeFileSync(path.join(project, ".cc-candybar.json5"), "{}");
    expect(resolveAt(answers, project).project.question?.standing).toBe(
      "approved",
    );
  });

  test("the project decision covers its worktrees even when an older worktree entry disagrees", () => {
    const legacy = { [project]: "approved", [wt]: "declined" } as const;
    expect(resolveAt(book(legacy), wt)).toMatchObject({
      layers: [{ path: path.join(wt, ".cc-candybar.json5"), role: "project" }],
      project: {
        approved: wt,
        question: { dir: project, standing: "approved" },
      },
    });
    expect(
      resolveAt(book({ [project]: "declined", [wt]: "approved" }), wt),
    ).toMatchObject({
      layers: [],
      project: {
        approved: null,
        question: { dir: project, standing: "declined" },
      },
    });

    const state = repoConfigs(path.join(root, "state"));
    writeStatePlan(state.plan(() => legacy));
    expect(recordAnswer(state, project, "approved")).toEqual({
      kind: "ok",
      value: { superseded: [wt], absent: [], unchecked: [] },
    });
    expect(state.read()).toEqual({
      kind: "ok",
      value: { [project]: "approved" },
    });
  });

  test("an entry whose directory is gone is kept and named, and the answer is recorded", () => {
    const gone = path.join(root, "removed-worktree");
    const state = repoConfigs(path.join(root, "state"));
    writeStatePlan(state.plan(() => ({ [gone]: "approved" })));
    expect(recordAnswer(state, project, "declined")).toEqual({
      kind: "ok",
      value: { superseded: [], absent: [gone], unchecked: [] },
    });
    expect(state.read()).toEqual({
      kind: "ok",
      value: { [gone]: "approved", [project]: "declined" },
    });
  });

  test("a directory that only claims to be a worktree answers for itself, says why, and loads without a throw", () => {
    const evil = path.join(root, "evil");
    fs.mkdirSync(evil);
    fs.symlinkSync(path.join(wt, ".git"), path.join(evil, ".git"));
    fs.writeFileSync(path.join(evil, ".cc-candybar.json5"), "{}");
    const resolved = resolveAt(book({ [project]: "approved" }), evil);
    expect(resolved).toMatchObject({
      layers: [],
      project: {
        approved: null,
        question: {
          dir: evil,
          standing: "awaiting",
          unproven: `${path.join(evil, ".git")} is not a file`,
        },
      },
    });

    // A moved worktree, and an entry for it in the book, throw nowhere.
    const moved = path.join(root, "moved");
    fs.renameSync(wt, moved);
    const state = repoConfigs(path.join(root, "state"));
    writeStatePlan(state.plan(() => ({ [moved]: "approved" })));
    expect(resolveAt(state.read() as RepoAnswers, moved).project).toMatchObject(
      {
        approved: moved,
        question: {
          dir: moved,
          standing: "approved",
          unproven: expect.any(String),
        },
      },
    );
    expect(recordAnswer(state, project, "approved")).toEqual({
      kind: "ok",
      value: { superseded: [], absent: [], unchecked: [] },
    });
  });
});
