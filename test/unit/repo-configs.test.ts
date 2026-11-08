// [LAW:behavior-not-structure] A repository's cc-candybar configs — its cwd
// and project layers and its `.cc-candybar/plugins/` — load only once the user
// approved the repository, and every resolution (the render, `check`, the
// durable writer) answers the same way. The answer is per repository, holds
// across edits (nothing here hashes a file) and covers every linked worktree.
// Over the filesystem fake: the worktrees are laid out as `git worktree add`
// lays them out, which test/worktree-link.test.ts proves against real git.

import path from "node:path";
import { MAIN_NAME } from "../../src/daemon/home";
import {
  filesystemFake,
  type FilesystemFake,
} from "../../src/disk/filesystem-fake";
import { heldClock } from "../helpers/held-clock";
import {
  configResolutionNotice,
  durableConfig,
  InstalledLayerMemo,
  resolveDslConfig,
} from "../../src/config/dsl-loader";
import { readConfigLoad } from "../../src/config/load";
import {
  readRepoAnswers,
  repoConfigsPath,
} from "../../src/config/loader/repo-book";
import type { RepoAnswers } from "../../src/config/loader/repo-gate";
import {
  configLoadedLine,
  type LoadCause,
  type ReloadedEntry,
} from "../../src/daemon/cache/render";
import {
  recordAnswer,
  repoAnswerFields,
  repoConfigs,
  repoQuestions,
} from "../../src/daemon/repo-configs";
import type { Locations } from "../../src/daemon/paths";
import { VERB_REPO_CONFIG } from "../../src/click/wire";
import { linkSigner } from "../../src/click/link-signer";
import { effectsOf } from "../helpers/click";

const root = "/w";
const project = path.join(root, "repo");
const state = path.join(root, "state");
const locs: Locations = {
  homeDir: path.join(root, "home"),
  configDir: path.join(root, "xdg", "cc-candybar"),
  dataHome: path.join(root, "data"),
  dataDirs: [],
};

let disk: FilesystemFake;
beforeEach(() => {
  disk = filesystemFake({ clock: heldClock(new Date(0)), platform: "darwin" });
  disk.mkdir(project);
});

const book = (value: Record<string, "approved" | "declined">): RepoAnswers => ({
  kind: "ok",
  value,
});

function write(rel: string, text: string): string {
  const file = path.join(project, rel);
  disk.mkdir(path.dirname(file));
  disk.write(file, text);
  return file;
}

const resolveAt = (answers: RepoAnswers, dir: string, configFile?: string) =>
  resolveDslConfig(disk, locs, answers, dir, dir, configFile);
const layersAt = (answers: RepoAnswers, dir: string) => {
  const r = resolveAt(answers, dir);
  return r.kind === "chain" ? r.layers.map((l) => l.path) : null;
};

describe("the gate over a project's config file", () => {
  test("unanswered, it is no layer, and the gate names the directory awaiting", () => {
    const file = write(".cc-candybar.json5", "{}");
    expect(layersAt(book({}), project)).toEqual([]);
    expect(resolveAt(book({}), project).repos).toEqual({
      plugins: null,
      approved: [],
      awaiting: [project],
      declined: [],
      unproven: [],
      unread: null,
    });
    expect(layersAt(book({ [project]: "approved" }), project)).toEqual([file]);
  });

  test("declined, it is no layer and nothing awaits", () => {
    write(".cc-candybar.json5", "{}");
    const resolved = resolveAt(book({ [project]: "declined" }), project);
    expect(resolved.kind === "chain" && resolved.layers).toEqual([]);
    expect(resolved.repos.awaiting).toEqual([]);
    expect(resolved.repos.declined).toEqual([project]);
  });

  test("the user's own file and an explicit path never ask", () => {
    const user = path.join(locs.configDir, "config.json5");
    disk.mkdir(locs.configDir);
    disk.write(user, "{}");
    expect(layersAt(book({}), project)).toEqual([user]);
    const named = write("named.json5", "{}");
    write(".cc-candybar.json5", "{}");
    const explicit = resolveAt(book({}), project, named);
    // An explicit file is the user's, whatever repository it sits in.
    expect(explicit.kind === "chain" && explicit.layers).toEqual([
      { path: named, scope: "plugins" },
    ]);
    expect(explicit.repos.awaiting).toEqual([]);
  });

  test("the durable writer's chain leaves out what the bar's leaves out", () => {
    write(".cc-candybar.json5", "{}");
    expect(
      durableConfig(
        disk,
        new InstalledLayerMemo(),
        locs,
        book({}),
        project,
        project,
      ).above,
    ).toEqual([]);
  });

  test("a book that cannot be read answers for nobody, asks nothing, and says so", () => {
    write(".cc-candybar.json5", "{}");
    const resolved = resolveAt(
      { kind: "failed", reason: "repo-configs.json is not JSON" },
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
  const load = () =>
    readConfigLoad(disk, {
      locations: locs,
      stateDir: state,
      projectDir: project,
      cwd: project,
      configFile: undefined,
      memo: new InstalledLayerMemo(),
    });
  const merged = (l: ReturnType<typeof load>) =>
    l.parsed.kind === "parsed" ? l.parsed.loaded.installed.loaded : null;

  test("a plugin folder awaits the directory's answer, and loads once approved", () => {
    write(".cc-candybar/plugins/deploy/plugin.json5", PLUGIN);
    const waiting = load();
    expect(waiting.repos.awaiting).toEqual([project]);
    expect(merged(waiting)).toEqual([]);

    expect(recordAnswer(disk, state, project, "approved").kind).toBe("ok");
    const approved = load();
    expect(approved.repos.awaiting).toEqual([]);
    expect(approved.repos.plugins).toBe(project);
    expect(merged(approved)).toEqual([
      {
        path: path.join(project, ".cc-candybar/plugins/deploy/plugin.json5"),
        scope: "repo",
        name: "deploy",
      },
    ]);
  });

  test("an empty plugin folder has nothing to ask about", () => {
    disk.mkdir(path.join(project, ".cc-candybar/plugins"));
    expect(resolveAt(book({}), project).repos.awaiting).toEqual([]);
  });
});

const loadedEntry: ReloadedEntry = {
  origin: { projectDir: "/p", cwd: "/p", target: { path: undefined } },
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
    ...loadedEntry,
    origin: { projectDir: project, cwd: project, target: { path: undefined } },
    repos: {
      plugins: null,
      approved: [],
      awaiting: ["/a", "/b"],
      declined: [],
      unproven: [{ dir: "/c", reason: "/x is not there" }],
      unread: null,
    },
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
    { to: MAIN_NAME, signer },
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
  const loose = path.join(state, "repo-configs.json");
  const other = path.join(root, "other");
  const file = (at: string, value: object): void => {
    disk.mkdir(path.dirname(at));
    disk.write(at, JSON.stringify(value));
  };

  test("is read while the folder holds no book", () => {
    file(loose, { [project]: "approved" });
    expect(readRepoAnswers(disk, state)).toEqual({
      kind: "ok",
      value: { [project]: "approved" },
    });
  });

  test("the first answer recorded writes it into the folder, with the answer", () => {
    file(loose, { [project]: "approved" });
    repoConfigs(disk, state).update((b) => ({ ...b, [other]: "declined" }));
    const filed = {
      kind: "ok",
      value: { [project]: "approved", [other]: "declined" },
    };
    expect(readRepoAnswers(disk, state)).toEqual(filed);
    expect(JSON.parse(disk.readFileSync(repoConfigsPath(state)))).toEqual(
      filed.value,
    );
  });

  test("is not read once the folder holds a book", () => {
    file(loose, { [project]: "approved" });
    file(repoConfigsPath(state), { [project]: "declined" });
    expect(readRepoAnswers(disk, state)).toEqual({
      kind: "ok",
      value: { [project]: "declined" },
    });
  });

  test("is read while the folder is a regular file, which holds no book", () => {
    file(loose, { [project]: "approved" });
    disk.write(path.dirname(repoConfigsPath(state)), "not a folder");
    expect(readRepoAnswers(disk, state)).toEqual({
      kind: "ok",
      value: { [project]: "approved" },
    });
  });

  test("a folder book a stat cannot see past is read, and its failure named", () => {
    file(loose, { [project]: "approved" });
    file(repoConfigsPath(state), { [project]: "declined" });
    disk.fault(repoConfigsPath(state), "EACCES");
    const read = readRepoAnswers(disk, state);
    expect(read.kind === "failed" && read.reason).toContain("EACCES");
  });
});

describe("a repository's worktrees answer as the repository", () => {
  const wt = path.join(root, "wt");
  // A main checkout at `project` and a linked worktree at `at`, as
  // `git worktree add` writes them: the worktree's `.git` file names its git
  // dir under the common dir's `worktrees/`, whose `commondir` leads back to
  // the common dir and whose `gitdir` points at the worktree's `.git`.
  const linkWorktree = (at: string): void => {
    const gitDir = path.join(project, ".git", "worktrees", path.basename(at));
    disk.mkdir(gitDir);
    disk.write(path.join(gitDir, "commondir"), "../..\n");
    disk.write(path.join(gitDir, "gitdir"), `${path.join(at, ".git")}\n`);
    disk.mkdir(at);
    disk.write(path.join(at, ".git"), `gitdir: ${gitDir}\n`);
  };

  beforeEach(() => {
    disk.mkdir(path.join(project, ".git"));
    linkWorktree(wt);
    disk.write(path.join(wt, ".cc-candybar.json5"), "{}");
    disk.mkdir(path.join(wt, ".cc-candybar/plugins/deploy"));
    disk.write(path.join(wt, ".cc-candybar/plugins/deploy/plugin.json5"), "{}");
  });

  test("a new worktree of an approved repository loads its config and plugins, and never asks", () => {
    expect(resolveAt(book({ [project]: "approved" }), wt)).toMatchObject({
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
    expect(resolveAt(book({ [project]: "declined" }), wt)).toMatchObject({
      layers: [],
      repos: { plugins: null, awaiting: [], declined: [project] },
    });
  });

  test("an unanswered repository's worktree asks for the repository, and its answer covers both", () => {
    expect(resolveAt(book({}), wt).repos.awaiting).toEqual([project]);
    expect(recordAnswer(disk, state, project, "approved").kind).toBe("ok");
    const answers = readRepoAnswers(disk, state);
    expect(layersAt(answers, wt)).toEqual([
      path.join(wt, ".cc-candybar.json5"),
    ]);
    disk.write(path.join(project, ".cc-candybar.json5"), "{}");
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

    repoConfigs(disk, state).update(() => legacy);
    expect(recordAnswer(disk, state, project, "approved")).toEqual({
      kind: "ok",
      value: { superseded: [wt], absent: [], unchecked: [] },
    });
    expect(readRepoAnswers(disk, state)).toEqual({
      kind: "ok",
      value: { [project]: "approved" },
    });
  });

  test("an entry whose directory is gone is kept and named, and the answer is recorded", () => {
    const gone = path.join(root, "removed-worktree");
    repoConfigs(disk, state).update(() => ({ [gone]: "approved" }));
    expect(recordAnswer(disk, state, project, "declined")).toEqual({
      kind: "ok",
      value: { superseded: [], absent: [gone], unchecked: [] },
    });
    expect(readRepoAnswers(disk, state)).toEqual({
      kind: "ok",
      value: { [gone]: "approved", [project]: "declined" },
    });
  });

  test("a directory that only claims to be a worktree answers for itself, says why, and loads without a throw", () => {
    const evil = path.join(root, "evil");
    disk.mkdir(evil);
    disk.symlink(path.join(wt, ".git"), path.join(evil, ".git"));
    disk.write(path.join(evil, ".cc-candybar.json5"), "{}");
    expect(resolveAt(book({ [project]: "approved" }), evil)).toMatchObject({
      layers: [],
      repos: {
        awaiting: [evil],
        unproven: [
          { dir: evil, reason: `${path.join(evil, ".git")} is not a file` },
        ],
      },
    });

    // A copy of a worktree's `.git` file claims that worktree: git's
    // back-pointer names the worktree's own `.git`, not the copy's.
    const copy = path.join(root, "copy");
    disk.mkdir(copy);
    disk.write(
      path.join(copy, ".git"),
      disk.readFileSync(path.join(wt, ".git")),
    );
    disk.write(path.join(copy, ".cc-candybar.json5"), "{}");
    expect(resolveAt(book({ [project]: "approved" }), copy)).toMatchObject({
      layers: [],
      repos: {
        awaiting: [copy],
        unproven: [
          {
            dir: copy,
            reason: `${path.join(project, ".git", "worktrees", "wt")} is the worktree at ${path.join(wt, ".git")}, not ${copy}`,
          },
        ],
      },
    });

    // A moved worktree, and an entry for it in the book, throw nowhere.
    const moved = path.join(root, "moved");
    disk.renameSync(wt, moved);
    repoConfigs(disk, state).update(() => ({ [moved]: "approved" }));
    expect(resolveAt(readRepoAnswers(disk, state), moved).repos).toMatchObject({
      approved: [moved],
      unproven: [{ dir: moved }],
    });
    expect(recordAnswer(disk, state, project, "approved")).toEqual({
      kind: "ok",
      value: { superseded: [], absent: [], unchecked: [] },
    });
  });
});
