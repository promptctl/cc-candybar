// A PR title merges only if the release can read it (scripts/pr-title.mjs).
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");

function check(title: string) {
  return spawnSync("node", [resolve(ROOT, "scripts/pr-title.mjs")], {
    encoding: "utf8",
    env: { ...process.env, PR_TITLE: title },
  });
}

describe("PR title check", () => {
  test.each([
    ["feat(menu): x", "minor"],
    ["fix: x", "patch"],
    // The release config ships a breaking change as a minor: this is that
    // config's own rule answering, not the preset's default of major.
    ["feat!: x", "minor"],
  ])("%p releases %s", (title, release) => {
    const run = check(title);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`pr-title: ok release=${release} `);
  });

  test.each(["test(views): x", "chore: x", "docs: x"])("%p is a type the config does not release", (title) => {
    const run = check(title);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("pr-title: ok release=none");
  });

  test.each([
    "feature(menu): x",
    "revert: undo x",
    "update: x",
    "A frame finds its session's view and opens nothing; an open feed pins it (8ro6 §5)",
    "",
  ])("%p is refused, naming only types that pass", (title) => {
    const run = check(title);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`pr-title: REFUSED ${JSON.stringify(title)}`);
    const [, listed = ""] = /types: (.*)$/m.exec(run.stderr) ?? [];
    const types = listed.split(", ");
    expect(types).toEqual(expect.arrayContaining(["feat", "fix", "test"]));
    expect(types).not.toContain("feature");
    expect(types).not.toContain("revert");
  });
});
