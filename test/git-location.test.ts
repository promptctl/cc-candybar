// The checkout's location: what `checkoutLocation` reads off a real
// checkout, and what `directory` draws from it. `gitaculous` reads the same
// payload fields only to decide whether it has a branch to show at all.
import { drawPayload } from "./helpers/draw-payload";
import { unscriptedRuns } from "./helpers/fake-launcher";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RichText } from "@promptctl/rich-js";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { registerDslConfig } from "../src/dsl/render";
import { SessionState, SINGLE_RUN } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { checkoutLocation } from "../src/utils/git-root";
import { instantOf } from "../src/utils/instant";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { TEST_LINKS } from "./helpers/link-signer";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { systemTimekeeper } from "../src/time";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" });

describe("checkoutLocation", () => {
  let tmp: string;
  let main: string;
  let linked: string;
  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loc-")));
    main = path.join(tmp, "repo");
    linked = path.join(tmp, "elsewhere", "my-tree");
    fs.mkdirSync(path.join(main, "src"), { recursive: true });
    git(main, "init", "-q");
    git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
    git(main, "worktree", "add", "-q", linked);
    fs.mkdirSync(path.join(linked, "src"));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true }));

  test("main checkout", () => {
    expect(checkoutLocation(main)).toEqual({ main, worktree: "", subpath: "", noRepo: false });
  });
  test("main checkout subdirectory", () => {
    expect(checkoutLocation(path.join(main, "src"))).toEqual({ main, worktree: "", subpath: "/src", noRepo: false });
  });
  test("linked worktree, wherever it lives", () => {
    expect(checkoutLocation(linked)).toEqual({ main, worktree: "my-tree", subpath: "", noRepo: false });
  });
  test("linked worktree subdirectory", () => {
    expect(checkoutLocation(path.join(linked, "src"))).toEqual({ main, worktree: "my-tree", subpath: "/src", noRepo: false });
  });
  test("no repo", () => {
    expect(checkoutLocation(tmp)).toEqual({ main: "", worktree: "", subpath: "", noRepo: true });
  });
});

function drawAll(
  payload: Record<string, unknown>,
  variables: object = {},
): Map<string, string> {
  const config = parseAndValidate(
    "<user>",
    JSON.stringify({ variables, root: { h: ["directory", "gitaculous"] } }),
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );
  const store = new VariableStore(systemTimekeeper);
  const registry = new SourceRegistry(unscriptedRuns(), store, "", new SessionState(SINGLE_RUN));
  const sink = new Map<string, readonly RichText[]>();
  try {
    const compiled = registerDslConfig(config, registry, { links: TEST_LINKS, cwd: "/tmp" });
    drawPayload(
      config,
      compiled,
      store,
      registry,
      { session_id: "s", home: "/home/me", ...payload },
      instantOf(new Date(0)),
      { endcaps: "powerline", colorCompatibility: "truecolor", wrap: true, padding: 0, width: Number.POSITIVE_INFINITY },
      { perSegmentSink: sink },
    ).frame;
  } finally {
    registry.dispose();
  }
  return new Map(
    ["directory", "gitaculous"].map((name) => [
      name,
      (sink.get(name) ?? []).map((t) => t.plain).join("").trim(),
    ]),
  );
}

function draw(payload: Record<string, unknown>, variables: object = {}): string {
  return drawAll(payload, variables).get("gitaculous") ?? "";
}

// Shared by both describes below: a session's location, varying only the
// worktree name and subpath, always with a settled "main" branch.
const MAIN = "/home/me/projects/cc-candybar";
const located = (worktree: string, subpath: string) => ({
  cwd: `/home/me/projects/cc-candybar/.claude/worktrees/x${subpath}`,
  location: { main: MAIN, worktree, subpath },
  git: { branch: "main" },
});

describe("directory, the worktree-aware location", () => {
  test("main checkout has no parenthetical", () => {
    expect(drawAll(located("", "")).get("directory")).toBe("~/p/cc-candybar");
  });
  test("linked worktree is named", () => {
    expect(drawAll(located("jumping", "")).get("directory")).toBe("~/p/cc-candybar (⊫ jumping)");
  });
  test("worktree subdirectory keeps the subpath", () => {
    expect(drawAll(located("jumping", "/src")).get("directory")).toBe("~/p/cc-candybar/src (⊫ jumping)");
  });
  test("no repo falls back to the session directory", () => {
    expect(
      drawAll({ workspace: { current_dir: "/home/me/scratch/notes" }, location: { main: "", worktree: "", subpath: "", noRepo: true } }).get("directory"),
    ).toBe("~/s/notes");
  });
  test("draws while git is still pending", () => {
    expect(
      drawAll({ ...located("jumping", ""), git: undefined }).get("directory"),
    ).toBe("~/p/cc-candybar (⊫ jumping)");
  });
});

describe("gitaculous, the git lane alone", () => {
  test("shows the git state, no path", () => {
    expect(draw(located("", ""))).toBe("⎇ main ▸");
  });
  test("a linked worktree draws the same git state", () => {
    expect(draw(located("jumping", ""))).toBe("⎇ main ▸");
  });
  test("no repo shows only the init offer", () => {
    expect(
      draw({ workspace: { current_dir: "/home/me/scratch/notes" }, location: { main: "", worktree: "", subpath: "", noRepo: true } }),
    ).toBe("init");
  });
  test("draws nothing while git is still pending", () => {
    expect(
      draw({ ...located("jumping", ""), git: undefined }),
    ).toBe("");
  });
});

test("a directory with no repo beside a live git answer keeps the git state", () => {
  expect(
    draw({
      workspace: { current_dir: "/tmp/x" },
      location: { main: "", worktree: "", subpath: "", noRepo: true },
      git: { branch: "main" },
    }),
  ).toBe("⎇ main ▸ init");
});

test("gitExpanded always shows the repo name, never the path", () => {
  const out = draw(
    { git: { branch: "main", repoName: "repo" }, location: { main: "/r", worktree: "", subpath: "", noRepo: false } },
    { "git.detail": { kind: "state", key: "git-detail", default: "expanded" } },
  );
  expect(out).toContain("(git) repo ");
  expect(out).not.toContain("/r");
});
