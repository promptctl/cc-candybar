// candybar-animation-wbxz.2yl.gnp — lane B starts from one variable and
// `claude`: BUN_OPTIONS preloads src/attach-preload.ts inside Claude Code,
// which replaces the process with the attach launcher. The exec itself runs
// only under Bun (measured live; see the ticket); these pin the decision.

import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  attachCommandLine,
  attachLauncherOf,
  attachPreloadOf,
} from "../src/attach-launcher";
import {
  bunWords,
  nodeOn,
  planExec,
  withoutPreload,
  type PreloadFacts,
} from "../src/attach-preload";

const DIST = "/opt/cc candybar/dist";
const SELF = attachPreloadOf(path.join(DIST, "index.mjs"));
const CLAUDE = "/home/u/.local/share/claude/versions/2.1.289";

const facts = (over: Partial<PreloadFacts> = {}): PreloadFacts => ({
  self: SELF,
  executable: CLAUDE,
  argv: ["bun", "/$bunfs/root/cli", "--resume", "abc", "--model", "opus"],
  env: {
    PATH: "relative/bin:/usr/local/bin:/usr/bin",
    HOME: "/home/u",
    BUN_OPTIONS: `--preload ${SELF.replace(/ /g, "\\ ")}`,
  },
  exists: (f) => f === attachLauncherOf(SELF),
  isExecutable: (f) => f === "/usr/local/bin/node" || f === "relative/bin/node",
  ...over,
});

describe("the attach preload", () => {
  test("execs the launcher beside it on this binary, with every argument the user typed", () => {
    const plan = planExec(facts());
    expect(plan).toEqual({
      kind: "exec",
      file: "/usr/local/bin/node",
      argv: [
        "/usr/local/bin/node",
        path.join(DIST, "cc-extra", "src", "bun-attach.js"),
        CLAUDE,
        "--resume",
        "abc",
        "--model",
        "opus",
      ],
      env: ["PATH=relative/bin:/usr/local/bin:/usr/bin", "HOME=/home/u"],
    });
  });

  test("takes itself out of BUN_OPTIONS, so no Bun process the session starts runs it again", () => {
    const other = "--smol";
    const plan = planExec(
      facts({
        env: {
          PATH: "/usr/local/bin",
          BUN_OPTIONS: `${other} --preload ${SELF.replace(/ /g, "\\ ")} -r /x/mine.js`,
        },
      }),
    );
    expect(plan.kind === "exec" && plan.env).toEqual([
      "PATH=/usr/local/bin",
      "BUN_OPTIONS=--smol -r /x/mine.js",
    ]);
    // `--preload=` keeps a backslash (measured), so Bun reads it only for a
    // path with no space.
    const plain = "/opt/cc-candybar/dist/attach-preload.cjs";
    expect(withoutPreload(`--preload=${plain}`, plain)).toBeNull();
    expect(withoutPreload(`-r ${SELF.replace(/ /g, "\\ ")}`, SELF)).toBeNull();
  });

  test("refuses, saying why, when there is no launcher beside it or no node on PATH", () => {
    expect(planExec(facts({ exists: () => false }))).toEqual({
      kind: "refused",
      why: expect.stringContaining(`attach launcher is not at ${attachLauncherOf(SELF)}`),
    });
    expect(
      planExec(facts({ env: { PATH: "relative/bin:/nowhere" } })),
    ).toEqual({ kind: "refused", why: "no `node` on PATH to run the attach launcher" });
  });

  test("finds node only in absolute PATH entries, first first", () => {
    const has = new Set(["/a/node", "/b/node", "rel/node"]);
    expect(nodeOn("rel:/b:/a", (f) => has.has(f))).toBe("/b/node");
    expect(nodeOn(undefined, () => true)).toBeNull();
  });

  test("reads BUN_OPTIONS as Bun does: whitespace splits, a backslash keeps the next character", () => {
    expect(bunWords("  --preload /a\\ b/x.js\t-r  /c\\\\d ")).toEqual([
      "--preload",
      "/a b/x.js",
      "-r",
      "/c\\d",
    ]);
  });

  test("the line a user types gives Bun the preload's path, whatever it holds", () => {
    for (const preload of [
      "/Users/u/code/cc-candybar/dist/attach-preload.cjs",
      "/Users/u/Library/Application Support/CCCandybar/dist/attach-preload.cjs",
      "/tmp/it's here/attach-preload.cjs",
    ]) {
      const line = attachCommandLine(preload);
      expect(line.endsWith(" claude")).toBe(true);
      const assignment = line.slice(0, -" claude".length);
      const value = execFileSync(
        "sh",
        ["-c", `${assignment} sh -c 'printf %s "$BUN_OPTIONS"'`],
        { encoding: "utf8" },
      );
      expect(bunWords(value)).toEqual(["--preload", preload]);
    }
    expect(attachCommandLine("/Users/u/code/cc-candybar/dist/attach-preload.cjs")).toBe(
      "BUN_OPTIONS='--preload /Users/u/code/cc-candybar/dist/attach-preload.cjs' claude",
    );
  });
});
