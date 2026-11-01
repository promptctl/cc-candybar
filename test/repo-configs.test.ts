// [LAW:behavior-not-structure] A repository's cc-candybar configs — its cwd
// and project layers and its `.cc-candybar/plugins/` — load only once the user
// approved the repository, and every resolution (the render, `check`, the
// durable writer) answers the same way. The answer is per repository, holds
// across edits (nothing here hashes a file) and covers every linked worktree.

import { processLauncher } from "../src/proc/launch";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkConfig } from "../src/check";
import {
  configResolutionNotice,
  durableConfig,
  resolveDslConfig,
} from "../src/config/dsl-loader";
import type { RepoAnswers } from "../src/config/loader/repo-gate";
import {
  configLoadedLine,
  loadFromDisk,
  UNOWNED_STORAGE,
  type LoadCause,
  type ReloadedEntry,
} from "../src/daemon/cache/render";
import {
  recordAnswer,
  repoAnswerFields,
  repoConfigs,
  repoConfigsPath,
  repoQuestions,
} from "../src/daemon/repo-configs";
import { SessionState } from "../src/daemon/session-state";
import { VERB_REPO_CONFIG } from "../src/click/wire";
import { linkSigner } from "../src/click/link-signer";
import { effectsOf } from "./helpers/click";
import { answerRepo } from "./helpers/repo-approval";

let root: string;
let project: string;
let savedXdg: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-repo-gate-")),
  );
  project = path.join(root, "repo");
  fs.mkdirSync(project);
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
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
  const r = resolveDslConfig(answers, project, project);
  return r.kind === "chain" ? r.layers.map((l) => l.path) : null;
};

describe("the gate over a project's config file", () => {
  test("unanswered, it is no layer, and the gate names the directory awaiting", () => {
    const file = write(".cc-candybar.json5", "{}");
    const resolved = resolveDslConfig(book({}), project, project);
    expect(layersOf(book({}))).toEqual([]);
    expect(resolved.repos).toEqual({
      plugins: null,
      approved: [],
      awaiting: [project],
      declined: [],
      unproven: [],
      unread: null,
    });
    expect(layersOf(book({ [project]: "approved" }))).toEqual([file]);
  });

  test("declined, it is no layer and nothing awaits", () => {
    write(".cc-candybar.json5", "{}");
    const resolved = resolveDslConfig(
      book({ [project]: "declined" }),
      project,
      project,
    );
    expect(resolved.kind === "chain" && resolved.layers).toEqual([]);
    expect(resolved.repos.awaiting).toEqual([]);
    expect(resolved.repos.declined).toEqual([project]);
  });

  test("the user's own file and an explicit path never ask", () => {
    const user = path.join(root, "xdg", "cc-candybar", "config.json5");
    fs.mkdirSync(path.dirname(user), { recursive: true });
    fs.writeFileSync(user, "{}");
    expect(layersOf(book({}))).toEqual([user]);
    const named = write("named.json5", "{}");
    write(".cc-candybar.json5", "{}");
    const explicit = resolveDslConfig(book({}), project, project, named);
    // An explicit file is the user's, whatever repository it sits in.
    expect(explicit.kind === "chain" && explicit.layers).toEqual([
      { path: named, scope: "plugins" },
    ]);
    expect(explicit.repos.awaiting).toEqual([]);
  });

  test("the durable writer's chain leaves out what the bar's leaves out", () => {
    write(".cc-candybar.json5", "{}");
    expect(durableConfig(book({}), project, project).above).toEqual([]);
  });

  test("a book that cannot be read answers for nobody, asks nothing, and says so", () => {
    write(".cc-candybar.json5", "{}");
    const resolved = resolveDslConfig(
      { kind: "failed", reason: "repo-configs.json is not JSON" },
      project,
      project,
    );
    expect(resolved.kind === "chain" && resolved.layers).toEqual([]);
    // A question it asked could not be recorded: the notice is the answer.
    expect(resolved.repos.awaiting).toEqual([]);
    expect(resolved.repos.declined).toEqual([]);
    expect(resolved.repos.unread).toBe("repo-configs.json is not JSON");
    // The bar's search notice stays about the search.
    expect(configResolutionNotice(resolved)).toBeNull();
  });
});

describe("the gate over a project's plugins", () => {
  const PLUGIN = `{ segments: { status: { template: "PLUGSEG" } } }`;

  test("a plugin folder awaits the directory's answer, and loads once approved", () => {
    write(".cc-candybar/plugins/deploy/plugin.json5", PLUGIN);
    const deps = {
      launcher: processLauncher,
      sessionState: new SessionState(),
      storage: UNOWNED_STORAGE,
      signer: linkSigner(Buffer.alloc(32)),
    };
    const waiting = loadFromDisk(project, project, undefined, deps);
    expect(waiting.repos.awaiting).toEqual([project]);
    expect(waiting.state!.plugins.loaded).toEqual([]);
    waiting.state!.registry.dispose();

    answerRepo(project);
    const approved = loadFromDisk(project, project, undefined, deps);
    expect(approved.repos.awaiting).toEqual([]);
    expect(approved.repos.plugins).toBe(project);
    expect(approved.state!.plugins.loaded).toEqual([
      {
        path: path.join(project, ".cc-candybar/plugins/deploy/plugin.json5"),
        scope: "repo", name: "deploy",
      },
    ]);
    approved.state!.registry.dispose();
  });

  test("an empty plugin folder has nothing to ask about", () => {
    fs.mkdirSync(path.join(project, ".cc-candybar/plugins"), {
      recursive: true,
    });
    expect(resolveDslConfig(book({}), project, project).repos.awaiting).toEqual(
      [],
    );
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
    const outcome = await checkConfig(undefined, project);
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
    const outcome = await checkConfig(undefined, project);
    expect(outcome).toMatchObject({
      kind: "clean",
      layers: [{ path: file, scope: "repo" }],
    });
    expect(fs.existsSync(marker)).toBe(true);
  });

  test("a directory whose worktree claim fails its proof is reported with the reason it answers for itself", async () => {
    write(".cc-candybar.json5", "{}");
    write(".git", "gitdir: /nonexistent/x\n");
    const outcome = await checkConfig(undefined, project);
    expect(outcome.kind).toBe("clean");
    if (outcome.kind !== "clean") return;
    expect(outcome.warnings).toContain(
      `not proven a worktree: ${project} — it answers for itself, because /nonexistent/x is not there`,
    );
  });
});

const loadedEntry: ReloadedEntry = {
  projectDir: "/p",
  cwd: "/p",
  configFile: undefined,
  configLayers: [],
  repos: {
    plugins: null,
    approved: [],
    awaiting: [],
    declined: [],
    unproven: [],
    unread: null,
  },
  lastError: null,
  lastWarning: null,
  state: undefined as never,
};

test.each<[LoadCause, string]>([
  [{ kind: "open" }, "open"],
  [{ kind: "write" }, "write"],
  [{ kind: "doctor" }, "doctor"],
  [
    {
      kind: "config-watch",
      heard: {
        kind: "changed",
        paths: new Set(["/p/config.json5", "/u/a.json"]),
      },
    },
    "config-watch:/p/config.json5,/u/a.json",
  ],
  [
    { kind: "answers-watch", heard: { kind: "unknown" } },
    "answers-watch:unknown",
  ],
  [
    { kind: "config-watch", heard: { kind: "failed", reason: "/d: EPERM" } },
    '"config-watch:failed:/d: EPERM"',
  ],
  [
    {
      kind: "events-resumed",
      since: Date.parse("2026-10-27T04:00:00.000Z"),
    },
    "events-resumed:2026-10-27T04:00:00.000Z",
  ],
])("the config loaded event says why the load ran: %j", (cause, field) => {
  expect(configLoadedLine(loadedEntry, cause, "built")).toContain(
    ` cwd=/p cause=${field} state=built files=`,
  );
});

test("the config loaded event names the repositories left waiting and declined, and the unproven worktrees", () => {
  const entry: ReloadedEntry = {
    projectDir: project,
    cwd: project,
    configFile: undefined,
    configLayers: [],
    repos: {
      plugins: null,
      approved: [],
      awaiting: ["/a", "/b"],
      declined: [],
      unproven: [{ dir: "/c", reason: "/x is not there" }],
      unread: null,
    },
      lastError: null,
    lastWarning: null,
    state: undefined as never,
  };
  const line = configLoadedLine(entry, { kind: "open" }, "built");
  expect(line).toContain(
    ` awaiting=/a,/b declined=- unproven=[{"dir":"/c","reason":"/x is not there"}] `,
  );
});

test("the question offers each answer as a link signed for its session, directory and answer", () => {
  const signer = linkSigner(Buffer.alloc(32, 7));
  const [channel, ...rest] = repoQuestions(
    {
      plugins: null,
      approved: [],
      awaiting: [project],
      declined: [],
      unproven: [],
      unread: null,
    },
    "sid-1",
    signer,
  );
  expect(rest).toEqual([]);
  expect(channel!.message).toBe(
    `a cc-candybar config for ${project} — run it?`,
  );
  const answers = channel!.lines[0]
    .flatMap((span) => (span.link === null ? [] : effectsOf(span.link)))
    .filter((e) => e.verb === VERB_REPO_CONFIG);
  expect(answers.map((e) => e.args.slice(0, 3))).toEqual([
    ["sid-1", project, "approved"],
    ["sid-1", project, "declined"],
  ]);
  for (const e of answers) {
    const [sid, dir, answer, mac] = e.args as [
      string,
      string,
      "approved",
      string,
    ];
    expect(signer.verify(repoAnswerFields(sid, dir, answer), mac)).toBe(true);
    // The mac answers for this answer only.
    const other = answer === "approved" ? "declined" : "approved";
    expect(signer.verify(repoAnswerFields(sid, dir, other), mac)).toBe(false);
  }
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

  test("the first answer recorded writes it into the folder, with the answer", () => {
    write(loose(), { [project]: "approved" });
    repoConfigs(state()).update((book) => ({ ...book, [other()]: "declined" }));
    const filed = {
      kind: "ok",
      value: { [project]: "approved", [other()]: "declined" },
    };
    expect(repoConfigs(state()).read()).toEqual(filed);
    expect(
      JSON.parse(fs.readFileSync(repoConfigsPath(state()), "utf8")),
    ).toEqual(filed.value);
  });

  test("is not read once the folder holds a book", () => {
    write(loose(), { [project]: "approved" });
    write(repoConfigsPath(state()), { [project]: "declined" });
    expect(repoConfigs(state()).read()).toEqual({
      kind: "ok",
      value: { [project]: "declined" },
    });
  });
});

describe("a repository's worktrees answer as the repository", () => {
  let wt: string;
  const git = (...args: string[]): void => {
    execFileSync("git", args, { stdio: "ignore" });
  };
  const resolveAt = (answers: RepoAnswers, dir: string) =>
    resolveDslConfig(answers, dir, dir);
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
      layers: [{ path: path.join(wt, ".cc-candybar.json5"), scope: "repo" }],
      repos: { plugins: wt, approved: [wt], awaiting: [], declined: [] },
    });
  });

  test("a worktree's own answer stands while its repository has none", () => {
    expect(resolveAt(book({ [wt]: "approved" }), wt)).toMatchObject({
      layers: [{ path: path.join(wt, ".cc-candybar.json5"), scope: "repo" }],
      repos: { plugins: wt, approved: [wt], awaiting: [] },
    });
    expect(resolveAt(book({ [wt]: "declined" }), wt)).toMatchObject({
      layers: [],
      repos: { plugins: null, awaiting: [], declined: [wt] },
    });
  });

  test("a declined repository's worktrees are declined", () => {
    const resolved = resolveAt(book({ [project]: "declined" }), wt);
    expect(resolved).toMatchObject({
      layers: [],
      repos: { plugins: null, awaiting: [], declined: [project] },
    });
  });

  test("an unanswered repository's worktree asks for the repository, and its answer covers both", () => {
    expect(resolveAt(book({}), wt).repos.awaiting).toEqual([project]);
    const state = repoConfigs(path.join(root, "state"));
    expect(recordAnswer(state, project, "approved").kind).toBe("ok");
    const answers = state.read() as RepoAnswers;
    expect(layersAt(answers, wt)).toEqual([
      path.join(wt, ".cc-candybar.json5"),
    ]);
    fs.writeFileSync(path.join(project, ".cc-candybar.json5"), "{}");
    expect(resolveAt(answers, project).repos.awaiting).toEqual([]);
  });

  test("a worktree's own answer that disagrees with its repository's asks, loads nothing, and the answer supersedes it", () => {
    const legacy = { [project]: "approved", [wt]: "declined" } as const;
    expect(resolveAt(book(legacy), wt)).toMatchObject({
      layers: [],
      repos: { plugins: null, approved: [], awaiting: [project] },
    });
    // One that agrees changes nothing.
    expect(
      resolveAt(book({ [project]: "approved", [wt]: "approved" }), wt).repos
        .approved,
    ).toEqual([wt]);

    const state = repoConfigs(path.join(root, "state"));
    state.update(() => legacy);
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
    state.update(() => ({ [gone]: "approved" }));
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
      repos: {
        awaiting: [evil],
        unproven: [
          { dir: evil, reason: `${path.join(evil, ".git")} is not a file` },
        ],
      },
    });

    // A moved worktree, and an entry for it in the book, throw nowhere.
    const moved = path.join(root, "moved");
    fs.renameSync(wt, moved);
    const state = repoConfigs(path.join(root, "state"));
    state.update(() => ({ [moved]: "approved" }));
    expect(resolveAt(state.read() as RepoAnswers, moved).repos).toMatchObject({
      approved: [moved],
      unproven: [{ dir: moved }],
    });
    expect(recordAnswer(state, project, "approved")).toEqual({
      kind: "ok",
      value: { superseded: [], absent: [], unchecked: [] },
    });
  });
});
