// [LAW:verifiable-goals] The host's interpreter over real files: a turn's
// changes splice into the files as they stand, keep every byte they do not
// touch, and land together or not at all. A layer change lands in the file
// discovery says its origin's role names, and one naming an origin or a role
// discovery does not hold, or an answer for a repository its origin does not
// ask about, is refused whole.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffChanges, type Change } from "../src/config/config-changes.js";
import {
  performChanges,
  type ApproveRepo,
  type LayerPlaces,
} from "../src/daemon/effect-interpreter.js";
import type { RenderOrigin } from "../src/config-hint.js";
import type { LayerRole } from "../src/config/layer-role.js";
import {
  repoConfigs,
  repoConfigsPath,
} from "../src/daemon/config-discovery/repo-configs.js";
import type { SessionId } from "../src/daemon/foundations/session-id.js";
import type {
  ConfigChange,
  EffectId,
} from "../src/renderer-interface/interface.js";

const USER = `{
  // mine
  globals: { padding: 1, theme: "dusk" },
}
`;
const PROJECT = `{ globals: { separator: " " } }\n`;

let dir: string;
let user: string;
let project: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-interpreter-"));
  user = path.join(dir, "user.json5");
  project = path.join(dir, "project.json5");
  fs.writeFileSync(user, USER);
  fs.writeFileSync(project, PROJECT);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// Discovery as the tests' changes need it: each origin followed, by its
// project directory, with the file each role of its chain names and the
// repository it asks about.
let chains: Map<string, Partial<Record<LayerRole, string>>>;
let repos: Map<string, string>;
beforeEach(() => {
  chains = new Map();
  repos = new Map();
});
const places: LayerPlaces = {
  path: (origin, role) => {
    const chain = chains.get(origin.projectDir);
    return chain === undefined ? undefined : (chain[role] ?? null);
  },
  repoDir: (origin) =>
    chains.has(origin.projectDir)
      ? (repos.get(origin.projectDir) ?? null)
      : undefined,
};
const originAt = (dir: string): RenderOrigin => ({
  projectDir: dir,
  cwd: dir,
  target: { source: "search" },
});

// The origin whose chain holds `file` at `role`: one per file, followed.
const holding = (file: string, role: LayerRole): RenderOrigin => {
  chains.set(file, { ...chains.get(file), [role]: file });
  return originAt(file);
};

let ids = 0;
const change = (
  file: string,
  before: string | null,
  after: string | null,
  role: LayerRole = "user",
): ConfigChange => ({
  kind: "change",
  id: ++ids as EffectId,
  session: "s" as SessionId,
  target: { kind: "layer", origin: holding(file, role), role },
  changes: diffChanges(before, after),
});

// A turn of layer changes, under a doctor that read no settings file.
const perform = (
  changes: readonly ConfigChange[],
  book: Parameters<typeof performChanges>[1],
) => performChanges(changes, book, () => [], places);

const read = (file: string): string => fs.readFileSync(file, "utf8");

describe("performChanges", () => {
  test("a change after one that removed its file reads the file as absent", () => {
    const removed = change(user, USER, null);
    // Read from the file as it stood: the removal ahead of it moved it.
    const edited = change(user, USER, USER.replace("padding: 1", "padding: 3"));
    expect(perform([removed, edited], null)).toMatchObject({
      kind: "refused",
    });
    expect(read(user)).toBe(USER);
  });

  test("splices a setting into the file as it stands, keeping every other byte", () => {
    const set = change(user, USER, USER.replace("padding: 1", "padding: 3"));
    fs.writeFileSync(user, USER.replace("// mine", "// mine, edited"));
    expect(perform([set], null)).toEqual({ kind: "ok" });
    expect(read(user)).toBe(
      USER.replace("// mine", "// mine, edited").replace(
        "padding: 1",
        "padding: 3",
      ),
    );
  });

  test("refuses a setting that moved, naming it, and writes nothing", () => {
    const set = change(user, USER, USER.replace("padding: 1", "padding: 3"));
    const moved = USER.replace("padding: 1", "padding: 5");
    fs.writeFileSync(user, moved);
    expect(perform([set], null)).toEqual({
      kind: "refused",
      reason: `globals.padding in ${user} changed since it was read (it was 1, it is 5) — nothing was written`,
    });
    expect(read(user)).toBe(moved);
  });

  test("a turn over two files lands neither when one setting moved", () => {
    const inUser = change(user, USER, USER.replace("padding: 1", "padding: 3"));
    const inProject = change(project, PROJECT, PROJECT.replace(`" "`, `"|"`));
    fs.writeFileSync(project, PROJECT.replace(`" "`, `"/"`));
    expect(perform([inUser, inProject], null).kind).toBe("refused");
    expect(read(user)).toBe(USER);
  });

  test("a write that fails puts back the file already written", () => {
    const inUser = change(user, USER, USER.replace("padding: 1", "padding: 3"));
    const unwritable = path.join(dir, "locked", "project.json5");
    fs.mkdirSync(path.dirname(unwritable));
    fs.writeFileSync(unwritable, PROJECT);
    fs.chmodSync(path.dirname(unwritable), 0o500);
    try {
      const outcome = perform(
        [inUser, change(unwritable, PROJECT, PROJECT.replace(`" "`, `"|"`))],
        null,
      );
      expect(outcome).toMatchObject({ kind: "failed" });
      expect(outcome.kind === "failed" && outcome.reason).toMatch(
        /nothing was written$/,
      );
      expect(read(user)).toBe(USER);
    } finally {
      fs.chmodSync(path.dirname(unwritable), 0o700);
    }
  });

  // Undo of a first-ever config write removes what that write created: the
  // target behind a link, never the link.
  test("a file removed through a link removes its target and keeps the link", () => {
    const link = path.join(dir, "linked.json5");
    fs.symlinkSync("dotfiles.json5", link);
    expect(perform([change(link, null, USER)], null)).toEqual({ kind: "ok" });
    expect(perform([change(link, USER, null)], null)).toEqual({ kind: "ok" });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(dir, "dotfiles.json5"))).toBe(false);
  });

  test("creates a file a change creates, and removes one it removes", () => {
    const fresh = path.join(dir, "fresh.json5");
    expect(perform([change(fresh, null, USER)], null)).toEqual({ kind: "ok" });
    expect(read(fresh)).toBe(USER);
    expect(perform([change(fresh, USER, null)], null)).toEqual({ kind: "ok" });
    expect(fs.existsSync(fresh)).toBe(false);
  });

  test("a change naming an origin discovery does not follow is refused, and nothing is written", () => {
    const set = change(user, USER, USER.replace("padding: 1", "padding: 3"));
    chains.delete(user);
    expect(perform([set], null)).toEqual({
      kind: "refused",
      reason: `a change names an origin config discovery does not follow (projectDir=${user} cwd=${user} configFile=-) — nothing was written`,
    });
    expect(read(user)).toBe(USER);
  });

  test("a change naming a role its origin's chain does not hold is refused, and no other change of the turn lands", () => {
    const inUser = change(user, USER, USER.replace("padding: 1", "padding: 3"));
    const unplaced: ConfigChange = {
      ...change(project, PROJECT, PROJECT.replace(`" "`, `"|"`)),
      target: { kind: "layer", origin: originAt(project), role: "local" },
    };
    expect(perform([inUser, unplaced], null)).toEqual({
      kind: "refused",
      reason: `a change names the local layer, and its origin's chain holds none (projectDir=${project} cwd=${project} configFile=-) — nothing was written`,
    });
    expect(read(user)).toBe(USER);
    expect(read(project)).toBe(PROJECT);
  });

  test("a change lands in the file its origin's role names now", () => {
    const moved = path.join(dir, "moved.json5");
    fs.writeFileSync(moved, USER);
    const set = change(user, USER, USER.replace("padding: 1", "padding: 3"));
    // Discovery found the role at another file since the change was made.
    chains.set(user, { user: moved });
    expect(perform([set], null)).toEqual({ kind: "ok" });
    expect(read(user)).toBe(USER);
    expect(read(moved)).toContain("padding: 3");
  });
});

// [LAW:verifiable-goals] A click's answers to the trust book land with its
// config changes or not at all: an answer decides which config a session
// renders, so a book written beside a config change that failed would trust
// a repository whose config the click never set.
describe("performChanges with the trust book", () => {
  // An answer for `dir` from an origin there that asks about it.
  const answer = (dir: string): ApproveRepo => {
    chains.set(dir, chains.get(dir) ?? {});
    repos.set(dir, dir);
    return {
      kind: "approve-repo",
      id: ++ids as EffectId,
      session: "s" as SessionId,
      origin: originAt(dir),
      dir,
      answer: "approved",
    };
  };

  test("an answer lands with the turn's changes, and its line is said once it has", () => {
    const state = path.join(dir, "state");
    const said: string[] = [];
    const outcome = perform(
      [change(user, USER, USER.replace("dusk", "dawn"))],
      { stateDir: state, answers: [answer(dir)], said: (l) => said.push(l) },
    );
    expect(outcome).toEqual({ kind: "ok" });
    expect(read(user)).toContain("dawn");
    expect(repoConfigs(state).read()).toEqual({
      kind: "ok",
      value: { [dir]: "approved" },
    });
    expect(said).toEqual([expect.stringMatching(/^repo-config: .* approved /)]);
  });

  test("a trust book that cannot be written leaves every config file as it was", () => {
    const state = path.join(dir, "state");
    const folder = path.dirname(repoConfigsPath(state));
    fs.mkdirSync(folder, { recursive: true });
    // The book reads as empty, and its folder takes no write: the config
    // change is written first, then put back.
    fs.chmodSync(folder, 0o500);
    try {
      const said: string[] = [];
      const outcome = perform(
        [change(user, USER, USER.replace("dusk", "dawn"))],
        { stateDir: state, answers: [answer(dir)], said: (l) => said.push(l) },
      );
      expect(outcome).toMatchObject({ kind: "failed" });
      expect(outcome.kind === "failed" && outcome.reason).toMatch(
        /nothing was written$/,
      );
      expect(read(user)).toBe(USER);
      expect(said).toEqual([]);
    } finally {
      fs.chmodSync(folder, 0o700);
    }
  });

  test("an answer for a repository its origin does not ask about is refused, and nothing is written", () => {
    const state = path.join(dir, "state");
    const asked = answer(dir);
    repos.set(dir, path.join(dir, "elsewhere"));
    const outcome = perform(
      [change(user, USER, USER.replace("dusk", "dawn"))],
      { stateDir: state, answers: [asked], said: () => {} },
    );
    expect(outcome).toEqual({
      kind: "refused",
      reason: `the answer for ${dir} is not for the repository its origin asks about (${path.join(dir, "elsewhere")}) — nothing was written`,
    });
    expect(read(user)).toBe(USER);
    expect(fs.existsSync(repoConfigsPath(state))).toBe(false);
  });

  test("an answer from an origin discovery does not follow is refused", () => {
    const state = path.join(dir, "state");
    const asked = answer(dir);
    chains.delete(dir);
    expect(
      perform([], { stateDir: state, answers: [asked], said: () => {} }),
    ).toMatchObject({ kind: "refused" });
    expect(fs.existsSync(repoConfigsPath(state))).toBe(false);
  });

  test("a change that moved since it was read writes no answer", () => {
    const state = path.join(dir, "state");
    fs.writeFileSync(user, USER.replace("dusk", "noon"));
    const outcome = perform(
      [change(user, USER, USER.replace("dusk", "dawn"))],
      { stateDir: state, answers: [answer(dir)], said: () => {} },
    );
    expect(outcome.kind).toBe("refused");
    expect(fs.existsSync(repoConfigsPath(state))).toBe(false);
  });
});

// [LAW:verifiable-goals] A local layer is one person's settings for a
// project, so git never shows it: the change that creates it names it in the
// repository's shared exclude file, in the same landing.
describe("a created local layer is kept out of git", () => {
  const LOCAL = `{ globals: { padding: 2 } }\n`;
  const repo = (): string => {
    const root = path.join(dir, "repo");
    fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
    return root;
  };

  test("its repository's exclude names it, beside what it already held", () => {
    const root = repo();
    const exclude = path.join(root, ".git", "info", "exclude");
    fs.writeFileSync(exclude, "# mine\n*.log");
    const local = path.join(root, ".cc-candybar.local.json5");
    expect(perform([change(local, null, LOCAL, "local")], null)).toEqual({
      kind: "ok",
    });
    expect(read(local)).toBe(LOCAL);
    expect(read(exclude)).toBe("# mine\n*.log\n/.cc-candybar.local.json5\n");
    // Written again, it is already named: the exclude is left as it is.
    fs.rmSync(local);
    perform([change(local, null, LOCAL, "local")], null);
    expect(read(exclude)).toBe("# mine\n*.log\n/.cc-candybar.local.json5\n");
  });

  test("a CRLF exclude that already names it is left as it is", () => {
    const root = repo();
    const exclude = path.join(root, ".git", "info", "exclude");
    fs.writeFileSync(exclude, "*.log\r\n/.cc-candybar.local.json5\r\n");
    const local = path.join(root, ".cc-candybar.local.json5");
    perform([change(local, null, LOCAL, "local")], null);
    expect(read(exclude)).toBe("*.log\r\n/.cc-candybar.local.json5\r\n");
  });

  test("a project under a directory named with glob characters is still ignored by git", () => {
    const root = path.join(dir, "mono");
    execFileSync("git", ["init", "-q", root]);
    const local = path.join(root, "app[v2]", ".cc-candybar.local.json5");
    fs.mkdirSync(path.dirname(local));
    perform([change(local, null, LOCAL, "local")], null);
    expect(
      execFileSync("git", ["check-ignore", local], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    ).toBe(local);
  });

  test("a linked worktree's goes in the exclude every worktree shares", () => {
    const main = repo();
    const meta = path.join(main, ".git", "worktrees", "wt");
    fs.mkdirSync(meta, { recursive: true });
    fs.writeFileSync(path.join(meta, "commondir"), "../..\n");
    const tree = path.join(dir, "wt");
    fs.mkdirSync(tree);
    fs.writeFileSync(path.join(tree, ".git"), `gitdir: ${meta}\n`);
    const local = path.join(tree, ".cc-candybar.local.json5");
    expect(perform([change(local, null, LOCAL, "local")], null)).toEqual({
      kind: "ok",
    });
    expect(read(path.join(main, ".git", "info", "exclude"))).toBe(
      "/.cc-candybar.local.json5\n",
    );
    expect(fs.existsSync(path.join(meta, "info", "exclude"))).toBe(false);
  });

  test("an edit to a local layer that exists, or a project layer created, writes no exclude", () => {
    const root = repo();
    const exclude = path.join(root, ".git", "info", "exclude");
    const local = path.join(root, ".cc-candybar.local.json5");
    fs.writeFileSync(local, LOCAL);
    const shared = path.join(root, ".cc-candybar.json5");
    perform(
      [
        change(local, LOCAL, LOCAL.replace("2", "3"), "local"),
        change(shared, null, LOCAL, "project"),
      ],
      null,
    );
    expect(fs.existsSync(exclude)).toBe(false);
  });

  test("a file named as a local layer that its chain holds as the user's writes no exclude", () => {
    const root = repo();
    const named = path.join(root, ".cc-candybar.local.json5");
    expect(perform([change(named, null, LOCAL, "user")], null)).toEqual({
      kind: "ok",
    });
    expect(fs.existsSync(path.join(root, ".git", "info", "exclude"))).toBe(
      false,
    );
  });

  test("an exclude that cannot be found refuses the whole change", () => {
    const tree = path.join(dir, "wt");
    fs.mkdirSync(tree);
    fs.writeFileSync(path.join(tree, ".git"), "not a gitdir line\n");
    const local = path.join(tree, ".cc-candybar.local.json5");
    expect(perform([change(local, null, LOCAL, "local")], null)).toMatchObject({
      kind: "failed",
    });
    expect(fs.existsSync(local)).toBe(false);
  });
});

describe("performChanges into Claude Code's settings", () => {
  const SETTINGS = `{
  "model": "opus",
  "env": { "FORCE_COLOR": "3" }
}
`;
  let settings: string;
  beforeEach(() => {
    settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, SETTINGS);
  });
  const into = (file: string, ...changes: Change[]): ConfigChange => ({
    kind: "change",
    id: ++ids as EffectId,
    session: "s" as SessionId,
    target: { kind: "claude-settings", file },
    changes,
  });
  const setColor = (was: string): Change => ({
    op: "replace",
    at: ["env", "FORCE_COLOR"],
    text: `"1"`,
    read: { kind: "value", text: was },
  });

  test("a setting as the doctor read it is written in strict JSON", () => {
    expect(
      performChanges(
        [into(settings, setColor(`"3"`))],
        null,
        () => [settings],
        places,
      ),
    ).toEqual({ kind: "ok" });
    expect(JSON.parse(read(settings))).toEqual({
      model: "opus",
      env: { FORCE_COLOR: "1" },
    });
  });

  test("a setting moved since the doctor read it is refused, and nothing is written", () => {
    const outcome = performChanges(
      [into(settings, setColor(`"2"`))],
      null,
      () => [settings],
      places,
    );
    expect(outcome.kind).toBe("refused");
    expect(read(settings)).toBe(SETTINGS);
  });

  test("a file the session's doctor did not read is refused", () => {
    expect(
      performChanges([into(settings, setColor(`"3"`))], null, () => [], places),
    ).toEqual({
      kind: "refused",
      reason: `${settings} is not a settings file the session's doctor read — nothing was written`,
    });
    expect(read(settings)).toBe(SETTINGS);
  });
});
