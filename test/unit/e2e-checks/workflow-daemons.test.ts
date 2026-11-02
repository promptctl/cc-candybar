import {
  commandsOf,
  jestConfigOf,
  leafCommands,
  stepsOf,
  violationsOf,
  type Repo,
} from "../../e2e-checks/workflow-daemons";

function repoOf(scripts: Record<string, string>, files: Record<string, string>): Repo {
  return { scripts, read: (path) => files[path] };
}

const workflow = (run: string, name = "ci.yml") => ({
  name,
  text: `name: ci\njobs:\n  test:\n    steps:\n      - name: go\n        run: ${JSON.stringify(run)}\n`,
});

describe("stepsOf", () => {
  test("lists run steps with their condition and skips uses steps", () => {
    const text = `
jobs:
  a:
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test
        if: github.event_name == 'pull_request'
  b:
    uses: ./.github/workflows/other.yml
`;
    expect(stepsOf(text, "w.yml")).toEqual([{ run: "pnpm test", condition: "github.event_name == 'pull_request'" }]);
  });

  test("fails on a document with no jobs", () => {
    expect(() => stepsOf("name: x", "w.yml")).toThrow("w.yml: a workflow needs a jobs mapping");
  });
});

describe("commandsOf", () => {
  test("splits on && and newlines and drops quotes", () => {
    expect(commandsOf('pnpm build && node "scripts/a.mjs"\nnode b.ts')).toEqual([
      ["pnpm", "build"],
      ["node", "scripts/a.mjs"],
      ["node", "b.ts"],
    ]);
  });
});

describe("leafCommands", () => {
  const repo = repoOf({ ci: "pnpm lint && node scripts/x.mjs", lint: "eslint src/", loop: "pnpm loop" }, {});

  test("expands pnpm run, bare pnpm and npm run to the script's commands", () => {
    expect(leafCommands("pnpm run ci", repo)).toEqual([["eslint", "src/"], ["node", "scripts/x.mjs"]]);
    expect(leafCommands("npm run lint", repo)).toEqual([["eslint", "src/"]]);
  });

  test("leaves a command that is no script alone, and expands a self-reference once", () => {
    expect(leafCommands("pnpm install --frozen-lockfile", repo)).toEqual([["pnpm", "install", "--frozen-lockfile"]]);
    expect(leafCommands("pnpm loop", repo)).toEqual([]);
  });
});

describe("jestConfigOf", () => {
  test.each([
    [["jest", "--config", "a.js"], "a.js"],
    [["jest", "--config=b.js"], "b.js"],
    [["jest"], undefined],
  ])("%j", (tokens, config) => {
    expect(jestConfigOf(tokens)).toBe(config);
  });
});

describe("violationsOf", () => {
  const files = {
    "scripts/safe.mjs": 'import { x } from "./lib/util.js";',
    "scripts/lib/util.ts": "export const x = 1;",
    "scripts/boot.ts": 'import { daemonArgs } from "../src/acquire.js";',
    "scripts/indirect.ts": 'import "./lib/hop.js";',
    "scripts/lib/hop.ts": 'export { createDaemon as make } from "../../src/daemon.js";',
    "src/acquire.ts": "export function daemonArgs() {}",
    "src/daemon.ts": "export function createDaemon() {}",
  };
  const scripts = {
    boot: "node --import tsx scripts/boot.ts",
    safe: "node scripts/safe.mjs",
    indirect: "tsx scripts/indirect.ts",
    "test:worker": "jest --config jest.worker.config.js",
  };
  const repo = repoOf(scripts, files);

  test("flags a step whose script imports a daemon symbol", () => {
    expect(violationsOf([workflow("pnpm run boot")], repo, [])).toEqual([
      { workflow: "ci.yml", step: "pnpm run boot", offender: "scripts/boot.ts" },
    ]);
  });

  test("follows relative imports and re-exports to a module that imports one", () => {
    expect(violationsOf([workflow("pnpm indirect")], repo, []).map((v) => v.offender)).toEqual(["scripts/lib/hop.ts"]);
  });

  test("passes a script that reaches none, and a jest run", () => {
    expect(violationsOf([workflow("pnpm safe && pnpm test:worker")], repo, [])).toEqual([]);
  });

  test("reaches a script named straight on the command line", () => {
    expect(violationsOf([workflow("node scripts/boot.ts")], repo, []).map((v) => v.offender)).toEqual(["scripts/boot.ts"]);
  });

  test("skips an excused workflow whole and still judges the others", () => {
    const workflows = [workflow("pnpm run boot", "load-gate.yml"), workflow("pnpm run boot", "other.yml")];
    expect(violationsOf(workflows, repo, ["load-gate.yml"]).map((v) => v.workflow)).toEqual(["other.yml"]);
  });
});
