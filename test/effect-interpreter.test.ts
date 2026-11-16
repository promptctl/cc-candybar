// [LAW:verifiable-goals] The host's interpreter over real files: a turn's
// changes splice into the files as they stand, keep every byte they do not
// touch, and land together or not at all.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffChanges } from "../src/config/config-changes.js";
import { performChanges } from "../src/daemon/effect-interpreter.js";
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
  test("splices a setting into the file as it stands, keeping every other byte", () => {
    const set = change(user, USER, USER.replace("padding: 1", "padding: 3"));
    fs.writeFileSync(user, USER.replace("// mine", "// mine, edited"));
    expect(performChanges([set])).toEqual({ kind: "ok" });
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
    expect(performChanges([set])).toEqual({
      kind: "refused",
      reason: `globals.padding in ${user} changed since it was read (it was 1, it is 5) — nothing was written`,
    });
    expect(read(user)).toBe(moved);
  });

  test("a turn over two files lands neither when one setting moved", () => {
    const inUser = change(user, USER, USER.replace("padding: 1", "padding: 3"));
    const inProject = change(project, PROJECT, PROJECT.replace(`" "`, `"|"`));
    fs.writeFileSync(project, PROJECT.replace(`" "`, `"/"`));
    expect(performChanges([inUser, inProject]).kind).toBe("refused");
    expect(read(user)).toBe(USER);
  });

  test("a write that fails puts back the file already written", () => {
    const inUser = change(user, USER, USER.replace("padding: 1", "padding: 3"));
    const unwritable = path.join(dir, "locked", "project.json5");
    fs.mkdirSync(path.dirname(unwritable));
    fs.writeFileSync(unwritable, PROJECT);
    fs.chmodSync(path.dirname(unwritable), 0o500);
    try {
      const outcome = performChanges([
        inUser,
        change(unwritable, PROJECT, PROJECT.replace(`" "`, `"|"`)),
      ]);
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
    expect(performChanges([change(link, null, USER)])).toEqual({ kind: "ok" });
    expect(performChanges([change(link, USER, null)])).toEqual({ kind: "ok" });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(dir, "dotfiles.json5"))).toBe(false);
  });

  test("creates a file a change creates, and removes one it removes", () => {
    const fresh = path.join(dir, "fresh.json5");
    expect(performChanges([change(fresh, null, USER)])).toEqual({ kind: "ok" });
    expect(read(fresh)).toBe(USER);
    expect(performChanges([change(fresh, USER, null)])).toEqual({ kind: "ok" });
    expect(fs.existsSync(fresh)).toBe(false);
  });
});
