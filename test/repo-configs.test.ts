// [LAW:behavior-not-structure] A repository's cc-candybar configs — its cwd
// and project layers and its `.cc-candybar/plugins/` — load only once the user
// approved the directory, and every resolution (the render, `check`, the
// durable writer) answers the same way. The answer is per directory and holds
// across edits: nothing here hashes a file.

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
  type ReloadedEntry,
} from "../src/daemon/cache/render";
import {
  repoAnswerFields,
  prepareRepoConfigs,
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

const layersOf = (answers: RepoAnswers): readonly string[] | null => {
  const r = resolveDslConfig(answers, project, project);
  return r.kind === "chain" ? r.layers : null;
};

describe("the gate over a project's config file", () => {
  test("unanswered, it is no layer, and the gate names the directory awaiting", () => {
    const file = write(".cc-candybar.json5", "{}");
    const resolved = resolveDslConfig(book({}), project, project);
    expect(layersOf(book({}))).toEqual([]);
    expect(resolved.repos).toEqual({
      plugins: null,
      awaiting: [project],
      declined: [],
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
    expect(explicit.kind === "chain" && explicit.layers).toEqual([named]);
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
      path.join(project, ".cc-candybar/plugins/deploy/plugin.json5"),
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
    expect(outcome).toMatchObject({ kind: "clean", layers: [file] });
    expect(fs.existsSync(marker)).toBe(true);
  });
});

test("the config loaded event names the repositories left waiting and declined", () => {
  const entry: ReloadedEntry = {
    projectDir: project,
    cwd: project,
    configFile: undefined,
    configLayers: [],
    repos: {
      plugins: null,
      awaiting: ["/a", "/b"],
      declined: [],
      unread: null,
    },
    failedFile: null,
    lastError: null,
    lastWarning: null,
    state: undefined as never,
  };
  const line = configLoadedLine(entry);
  expect(line).toContain(" awaiting=/a,/b declined=- ");
});

test("the question offers each answer as a link signed for its session, directory and answer", () => {
  const signer = linkSigner(Buffer.alloc(32, 7));
  const [channel, ...rest] = repoQuestions(
    { plugins: null, awaiting: [project], declined: [], unread: null },
    "sid-1",
    signer,
  );
  expect(rest).toEqual([]);
  expect(channel!.message).toBe(
    `${project} has a cc-candybar config — run it?`,
  );
  const answers = channel!.lines[0]
    .flatMap((span) => effectsOf(span.link))
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
  const loose = (): string => path.join(root, "state", "repo-configs.json");
  const write = (file: string, answer: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ [project]: answer }));
  };
  const state = (): string => path.join(root, "state");

  test("moves into the book's folder when the daemon prepares it", () => {
    write(loose(), "approved");
    expect(prepareRepoConfigs(state())).toBeNull();
    expect(fs.existsSync(loose())).toBe(false);
    expect(repoConfigs(state()).read()).toEqual({
      kind: "ok",
      value: { [project]: "approved" },
    });
  });

  test("never replaces a book already in the folder, and says so", () => {
    write(loose(), "approved");
    write(repoConfigsPath(state()), "declined");
    expect(prepareRepoConfigs(state())).toBe(
      `${loose()} is not read: the answers are kept in ${repoConfigsPath(state())}`,
    );
    expect(repoConfigs(state()).read()).toEqual({
      kind: "ok",
      value: { [project]: "declined" },
    });
  });

  test("with no book anywhere, makes the folder and nothing else", () => {
    fs.mkdirSync(state());
    expect(prepareRepoConfigs(state())).toBeNull();
    expect(fs.readdirSync(state())).toEqual(["repo-configs"]);
    expect(fs.readdirSync(path.join(state(), "repo-configs"))).toEqual([]);
  });
});
