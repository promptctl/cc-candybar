// The release pin: nothing publishes a major other than 1 (scripts/major-guard.mjs).
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");

function guard(version: string) {
  return spawnSync("node", [resolve(ROOT, "scripts/major-guard.mjs"), version], { encoding: "utf8" });
}

describe("major guard", () => {
  test.each(["1.0.0", "1.148.8", "1.200.0-beta.1"])("admits %s", (v) => {
    expect(guard(v).status).toBe(0);
  });

  test.each(["2.0.0", "10.1.0", "0.9.0", "2.0.0-beta.1", "", "v1.2.3", "1.2"])("refuses %p", (v) => {
    const run = guard(v);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("major-guard: REFUSED");
  });

  test("release.mjs refuses a 2.x before it publishes anything", () => {
    const run = spawnSync("node", [resolve(ROOT, "scripts/release.mjs"), "2.0.0"], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("2.0.0 is major 2");
    expect(run.stdout).not.toContain("preparing per-platform packages");
  });

  test("prepublishOnly runs the guard first", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.prepublishOnly).toMatch(/^node scripts\/major-guard\.mjs "\$npm_package_version" && /);
  });
});

describe("release-pin hook", () => {
  function hook(tool_name: string, tool_input: Record<string, string>) {
    return spawnSync("node", [resolve(ROOT, ".claude/hooks/release-pin.mjs")], {
      input: JSON.stringify({ tool_name, tool_input }),
      encoding: "utf8",
    });
  }

  test.each<[string, Record<string, string>]>([
    ["Edit", { file_path: `${ROOT}/scripts/major-guard.mjs` }],
    ["Write", { file_path: `${ROOT}/.claude/settings.json` }],
    ["Edit", { file_path: `${ROOT}/.claude/hooks/release-pin.mjs` }],
    ["Bash", { command: "sed -i '' s/1/2/ scripts/major-guard.mjs" }],
    ["Bash", { command: "gh api -X DELETE repos/promptctl/cc-candybar/rulesets/25525264" }],
    ["Bash", { command: "gh api --method PUT repos/promptctl/cc-candybar/rulesets/25525264 --input r.json" }],
  ])("refuses %s %j", (tool, input) => {
    const run = hook(tool, input);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("release-pin: refused");
  });

  test.each<[string, Record<string, string>]>([
    ["Edit", { file_path: `${ROOT}/src/index.ts` }],
    ["Read", { file_path: `${ROOT}/scripts/major-guard.mjs` }],
    ["Bash", { command: "cat scripts/major-guard.mjs" }],
    ["Bash", { command: "gh api repos/promptctl/cc-candybar/rulesets" }],
    ["Bash", { command: "pnpm test" }],
  ])("admits %s %j", (tool, input) => {
    expect(hook(tool, input).status).toBe(0);
  });
});

describe("semantic-release under .releaserc.json", () => {
  // The repo's own commit-analyzer config, run on the commits that once cut 2.0.0 (#368).
  function releaseType(message: string): string | null {
    const script = `
      import { readFileSync } from "node:fs";
      import { analyzeCommits } from "@semantic-release/commit-analyzer";
      const rc = JSON.parse(readFileSync(".releaserc.json", "utf8"));
      const [, config] = rc.plugins.find((p) => Array.isArray(p) && p[0] === "@semantic-release/commit-analyzer");
      const quiet = { log() {} };
      const type = await analyzeCommits(config, {
        cwd: process.cwd(), logger: quiet,
        commits: [{ hash: "0", message: process.argv[1] }],
      });
      process.stdout.write(JSON.stringify(type ?? null));
    `;
    const out = execFileSync("node", ["--input-type=module", "-e", script, message], { cwd: ROOT, encoding: "utf8" });
    return JSON.parse(out);
  }

  test.each([
    "feat: drop the legacy layout\n\nBREAKING CHANGE: layout rows are gone",
    "fix: rename a flag\n\nBREAKING CHANGE: --old is now --new",
  ])("a breaking commit releases a minor: %p", (message) => {
    expect(releaseType(message)).toBe("minor");
  });

  test("ordinary commits keep their default release types", () => {
    expect(releaseType("feat: a thing")).toBe("minor");
    expect(releaseType("fix: a bug")).toBe("patch");
  });
});
