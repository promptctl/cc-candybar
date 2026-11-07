// [LAW:behavior-not-structure] `check` runs a repository's cc-candybar config
// only once the user approved the repository, as the bar does. The gate's own
// cases run over the filesystem fake in test/unit/repo-configs.test.ts; these
// stay on the disk because `check` launches the config's sources.

import { hostOf, worldOf, mainEnv } from "./helpers/host";
import type { World } from "../src/host";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkConfig } from "../src/check";
import { answerRepo } from "./helpers/repo-approval";
import { daemonGates } from "../src/daemon/update-keys";
import type { Host } from "../src/host";

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
  host = hostOf({ ...mainEnv(), XDG_CONFIG_HOME: path.join(root, "xdg") });
  world = worldOf(host);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, text: string): string {
  const file = path.join(project, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

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
    const outcome = await checkConfig(world, daemonGates(), undefined, project);
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
    answerRepo(project, "approved", host.env);
    const outcome = await checkConfig(world, daemonGates(), undefined, project);
    expect(outcome).toMatchObject({
      kind: "clean",
      layers: [{ path: file, scope: "repo" }],
    });
    expect(fs.existsSync(marker)).toBe(true);
  });

  test("a directory whose worktree claim fails its proof is reported with the reason it answers for itself", async () => {
    write(".cc-candybar.json5", "{}");
    write(".git", "gitdir: /nonexistent/x\n");
    const outcome = await checkConfig(world, daemonGates(), undefined, project);
    expect(outcome.kind).toBe("clean");
    if (outcome.kind !== "clean") return;
    expect(outcome.warnings).toContain(
      `not proven a worktree: ${project} — it answers for itself, because /nonexistent/x is not there`,
    );
  });
});
