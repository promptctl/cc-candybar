// [LAW:verifiable-goals] brandon-unfiled-3248.99f8, on the real launcher: a
// process whose shell set GIT_DIR, GIT_WORK_TREE and GH_REPO drops them as its
// world is built, so the renderer it launches starts without them, and
// `cc-candybar doctor` run there draws the bar of its working directory's
// repository and names what was dropped. The session's report of its own
// environment keeps them: there they are the session's. When git cannot name
// the variables, the doctor's row fails with the reason and the bar is still
// the working directory's.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hostOver, worldOf } from "../helpers/host";
import {
  HEALTHY_INSTALL_EDGE,
  healthyDaemonEdge,
  healthyDataEdge,
  noUrlHandlerEdge,
} from "../helpers/doctor-facts";
import { until } from "../helpers/until";
import type { Host } from "../../src/host";
import { doctorPlan } from "../../src/doctor/cli";
import { productionMachineEdge } from "../../src/doctor/edge";
import { mainRendererOf } from "../../src/renderer/main";
import type { RendererBuilder } from "../../src/daemon/local-bar";
import { rendererOf } from "../../src/renderer-interface/interface";
import type { AdapterToHost } from "../../src/renderer-interface/adapter";
import type { RendererBoot } from "../../src/renderer-interface/wire";
import { processPort } from "../../src/daemon/renderer-process";
import { MAIN_RENDERER } from "../../src/daemon/foundations/renderer-name";
import { reportedEnvironment } from "../../src/daemon/foundations/session-env";
import { parseFrame, textOf } from "../../src/render/frame";
import { systemTimekeeper } from "../../src/time";

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();
const LEAKED = ["GIT_DIR", "GIT_WORK_TREE", "GH_REPO"];

let dir: string;
let other: string;
let session: string;
let config: string;

function commit(repo: string, branch: string): void {
  fs.mkdirSync(repo);
  const run = (...args: string[]) =>
    execFileSync(REAL_GIT, args, { cwd: repo, stdio: "pipe" });
  run("init", "-q", "-b", branch);
  run(
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
}

beforeEach(() => {
  dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-repo-env-")),
  );
  other = path.join(dir, "other");
  commit(other, "elsewhere");
  session = path.join(dir, "session");
  commit(session, "mine");
  fs.writeFileSync(path.join(session, "new.txt"), "x");
  config = path.join(dir, "bar.json5");
  fs.writeFileSync(
    config,
    `{ segments: { g: { template: 'b:{{ .git.branch }} u:{{ .git.untracked }}' } }, root: { h: ['g'] } }`,
  );
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// A shell whose repository is `other`, with `bin` ahead on its PATH.
const shellHost = (bin: string | null = null): Host =>
  hostOver({
    env: {
      PATH: bin === null ? process.env.PATH : `${bin}:${process.env.PATH}`,
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_STATE_HOME: path.join(dir, "state"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      CC_CANDYBAR_SOCKET: path.join(dir, "no-daemon.sock"),
      CC_CANDYBAR_CLAUDE_MANAGED_DIR:
        process.env.CC_CANDYBAR_CLAUDE_MANAGED_DIR,
      TERM_PROGRAM: "ghostty",
      TERM_PROGRAM_VERSION: "1.3.1",
      GIT_DIR: path.join(other, ".git"),
      GIT_WORK_TREE: other,
      GH_REPO: "x/elsewhere",
    },
    home: dir,
    tmp: dir,
  });

test("the renderer's process starts without the shell's repository, and the session's report keeps it", async () => {
  const host = shellHost();
  expect(host.dropped).toMatchObject({ fault: null });
  for (const name of LEAKED) expect(host.dropped.names).toContain(name);
  expect(host.env.GIT_DIR).toBeUndefined();
  // A renderer's entry that writes the environment it was started with, then
  // waits for its stdin's end, as a renderer does.
  const printed = path.join(dir, "renderer-env.json");
  const entry = path.join(dir, "renderer.cjs");
  fs.writeFileSync(
    entry,
    `require("fs").writeFileSync(${JSON.stringify(printed)}, JSON.stringify(process.env));
process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`,
  );
  const world = worldOf(host);
  const link = processPort({
    launcher: world.launcher,
    entry,
    cwd: dir,
    heapCapMb: 64,
  })({
    name: MAIN_RENDERER,
    build: () => {
      throw new Error("the renderer runs in its own process here");
    },
    boot: () => ({}) as RendererBoot,
    node: [process.execPath],
  }).start({
    reaches: {} as AdapterToHost,
    log: () => {},
    clock: systemTimekeeper,
    start: async () => {},
    ended: () => {},
  });
  link.serve();
  link.arm();
  try {
    await until(() => fs.existsSync(printed), "the renderer's environment");
  } finally {
    link.beginClose();
    await link.close();
  }
  const env = JSON.parse(fs.readFileSync(printed, "utf8")) as Record<
    string,
    string
  >;
  for (const name of LEAKED) expect(env[name]).toBeUndefined();
  expect(reportedEnvironment(host)).toMatchObject({
    GIT_DIR: path.join(other, ".git"),
    GIT_WORK_TREE: other,
    GH_REPO: "x/elsewhere",
  });
});

// `cc-candybar doctor` in `session`, from the shell `host` stands for: the
// machine's own edge, with every probe but what the host dropped scripted
// healthy, and the bars the run drew.
async function doctorIn(host: Host) {
  const bars: string[] = [];
  const build: RendererBuilder = (inputs, reaches) => {
    const renderer = mainRendererOf(inputs, reaches);
    return rendererOf({
      event: async (input) => {
        const output = await renderer.answer(input);
        for (const effect of output.effects)
          if (effect.kind === "present")
            bars.push(textOf(parseFrame(effect.frame)));
        return output;
      },
      adapter: (input) => renderer.answer(input),
    });
  };
  const out = await doctorPlan({
    world: worldOf(host),
    cwd: session,
    configFile: config,
    measureTerminal: () => ({ columns: 120 }),
    edge: (launcher, edgeHost, stateDir) => ({
      ...productionMachineEdge(launcher, edgeHost, stateDir),
      install: HEALTHY_INSTALL_EDGE,
      ...healthyDaemonEdge(),
      ...healthyDataEdge(),
      ...noUrlHandlerEdge(),
      probeTmux: async () => {
        throw new Error("probeTmux must not run outside tmux");
      },
      remoteLogin: async () => {
        throw new Error("remoteLogin must not run outside tmux");
      },
      fontInUse: async () => {
        throw new Error("fontInUse must not run for this config");
      },
    }),
    build,
  });
  return { out, bars };
}

const rowOf = (stdout: string): string =>
  stdout.split("\n").find((l) => / environment\b/.test(l.slice(0, 16))) ?? "";

test("`cc-candybar doctor` from that shell draws its working directory's repository, and names what it dropped", async () => {
  const { out, bars } = await doctorIn(shellHost());
  expect(bars.at(-1)).toContain("b:mine u:1");
  expect(rowOf(out.stdout)).toMatch(
    /^✓ environment — GIT_DIR, GIT_WORK_TREE, GH_REPO unset of the variables that locate a repository \(.* GIT_DIR .* GH_REPO\)$/,
  );
});

test.each([
  ["fails", `echo "fatal: not today" >&2; exit 128`, "exited with code 128"],
  ["names nothing", "exit 0", "named no variable"],
  [
    "prints the flag back",
    "echo --local-env-vars; exit 0",
    `answered "--local-env-vars", which is no variable's name`,
  ],
])(
  "a git whose ask %s: the doctor's row fails with the reason, and the bar is still the working directory's",
  async (_, answer, said) => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh
if [ "$1" = rev-parse ] && [ "$2" = --local-env-vars ]; then
${answer}
fi
exec "${REAL_GIT}" "$@"
`,
      { mode: 0o755 },
    );
    const host = shellHost(bin);
    expect(host.dropped.fault).toContain(said);
    for (const name of LEAKED) expect(host.env[name]).toBeUndefined();
    const { out, bars } = await doctorIn(host);
    expect(bars.at(-1)).toContain("b:mine u:1");
    expect(rowOf(out.stdout)).toContain(
      `✗ environment — \`git rev-parse --local-env-vars\` ${said}`,
    );
    expect(out.stdout).toContain(
      "    GIT_DIR, GIT_WORK_TREE, GH_REPO unset of the variables",
    );
    expect(out.stderr).toBe("");
    expect(out.code).toBe(1);
  },
);
