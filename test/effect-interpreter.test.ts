// [LAW:verifiable-goals] The host's interpreter over real files: a turn's
// changes splice into the files as they stand, keep every byte they do not
// touch, and land together or not at all.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffChanges } from "../src/config/config-changes.js";
import {
  performChanges,
  type ApproveRepo,
} from "../src/daemon/effect-interpreter.js";
import { repoConfigs, repoConfigsPath } from "../src/config/repo-configs.js";
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

let ids = 0;
const change = (
  file: string,
  before: string | null,
  after: string | null,
): ConfigChange => ({
  kind: "change",
  id: ++ids as EffectId,
  session: "s" as SessionId,
  target: { kind: "layer", path: file },
  changes: diffChanges(before, after),
});

const read = (file: string): string => fs.readFileSync(file, "utf8");

describe("performChanges", () => {
  test("a change after one that removed its file reads the file as absent", () => {
    const removed = change(user, USER, null);
    // Read from the file as it stood: the removal ahead of it moved it.
    const edited = change(user, USER, USER.replace("padding: 1", "padding: 3"));
    expect(performChanges([removed, edited], null)).toMatchObject({
      kind: "refused",
    });
    expect(read(user)).toBe(USER);
  });

  test("splices a setting into the file as it stands, keeping every other byte", () => {
    const set = change(user, USER, USER.replace("padding: 1", "padding: 3"));
    fs.writeFileSync(user, USER.replace("// mine", "// mine, edited"));
    expect(performChanges([set], null)).toEqual({ kind: "ok" });
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
    expect(performChanges([set], null)).toEqual({
      kind: "refused",
      reason: `globals.padding in ${user} changed since it was read (it was 1, it is 5) — nothing was written`,
    });
    expect(read(user)).toBe(moved);
  });

  test("a turn over two files lands neither when one setting moved", () => {
    const inUser = change(user, USER, USER.replace("padding: 1", "padding: 3"));
    const inProject = change(project, PROJECT, PROJECT.replace(`" "`, `"|"`));
    fs.writeFileSync(project, PROJECT.replace(`" "`, `"/"`));
    expect(performChanges([inUser, inProject], null).kind).toBe("refused");
    expect(read(user)).toBe(USER);
  });

  test("a write that fails puts back the file already written", () => {
    const inUser = change(user, USER, USER.replace("padding: 1", "padding: 3"));
    const unwritable = path.join(dir, "locked", "project.json5");
    fs.mkdirSync(path.dirname(unwritable));
    fs.writeFileSync(unwritable, PROJECT);
    fs.chmodSync(path.dirname(unwritable), 0o500);
    try {
      const outcome = performChanges(
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
    expect(performChanges([change(link, null, USER)], null)).toEqual({ kind: "ok" });
    expect(performChanges([change(link, USER, null)], null)).toEqual({ kind: "ok" });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(dir, "dotfiles.json5"))).toBe(false);
  });

  test("creates a file a change creates, and removes one it removes", () => {
    const fresh = path.join(dir, "fresh.json5");
    expect(performChanges([change(fresh, null, USER)], null)).toEqual({ kind: "ok" });
    expect(read(fresh)).toBe(USER);
    expect(performChanges([change(fresh, USER, null)], null)).toEqual({ kind: "ok" });
    expect(fs.existsSync(fresh)).toBe(false);
  });
});

// [LAW:verifiable-goals] A click's answers to the trust book land with its
// config changes or not at all: an answer decides which config a session
// renders, so a book written beside a config change that failed would trust
// a repository whose config the click never set.
describe("performChanges with the trust book", () => {
  const answer = (dir: string): ApproveRepo => ({
    kind: "approve-repo",
    id: ++ids as EffectId,
    session: "s" as SessionId,
    dir,
    answer: "approved",
  });

  test("an answer lands with the turn's changes, and its line is said once it has", () => {
    const state = path.join(dir, "state");
    const said: string[] = [];
    const outcome = performChanges(
      [change(user, USER, USER.replace("dusk", "dawn"))],
      { stateDir: state, answers: [answer(dir)], said: (l) => said.push(l) },
    );
    expect(outcome).toEqual({ kind: "ok" });
    expect(read(user)).toContain("dawn");
    expect(repoConfigs(state).read()).toEqual({ kind: "ok", value: { [dir]: "approved" } });
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
      const outcome = performChanges(
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

  test("a change that moved since it was read writes no answer", () => {
    const state = path.join(dir, "state");
    fs.writeFileSync(user, USER.replace("dusk", "noon"));
    const outcome = performChanges(
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
    expect(performChanges([change(local, null, LOCAL)], null)).toEqual({
      kind: "ok",
    });
    expect(read(local)).toBe(LOCAL);
    expect(read(exclude)).toBe("# mine\n*.log\n/.cc-candybar.local.json5\n");
    // Written again, it is already named: the exclude is left as it is.
    fs.rmSync(local);
    performChanges([change(local, null, LOCAL)], null);
    expect(read(exclude)).toBe("# mine\n*.log\n/.cc-candybar.local.json5\n");
  });

  test("a CRLF exclude that already names it is left as it is", () => {
    const root = repo();
    const exclude = path.join(root, ".git", "info", "exclude");
    fs.writeFileSync(exclude, "*.log\r\n/.cc-candybar.local.json5\r\n");
    const local = path.join(root, ".cc-candybar.local.json5");
    performChanges([change(local, null, LOCAL)], null);
    expect(read(exclude)).toBe("*.log\r\n/.cc-candybar.local.json5\r\n");
  });

  test("a project under a directory named with glob characters is still ignored by git", () => {
    const root = path.join(dir, "mono");
    execFileSync("git", ["init", "-q", root]);
    const local = path.join(root, "app[v2]", ".cc-candybar.local.json5");
    fs.mkdirSync(path.dirname(local));
    performChanges([change(local, null, LOCAL)], null);
    expect(
      execFileSync("git", ["check-ignore", local], { cwd: root, encoding: "utf8" }).trim(),
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
    expect(performChanges([change(local, null, LOCAL)], null)).toEqual({
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
    performChanges(
      [
        change(local, LOCAL, LOCAL.replace("2", "3")),
        change(shared, null, LOCAL),
      ],
      null,
    );
    expect(fs.existsSync(exclude)).toBe(false);
  });

  test("an exclude that cannot be found refuses the whole change", () => {
    const tree = path.join(dir, "wt");
    fs.mkdirSync(tree);
    fs.writeFileSync(path.join(tree, ".git"), "not a gitdir line\n");
    const local = path.join(tree, ".cc-candybar.local.json5");
    expect(performChanges([change(local, null, LOCAL)], null)).toMatchObject({
      kind: "failed",
    });
    expect(fs.existsSync(local)).toBe(false);
  });
});
