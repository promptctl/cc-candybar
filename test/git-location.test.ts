// The git segment's location: what `checkoutLocation` reads off a real
// checkout, and what `gitaculous` draws from it.
import { drawPayload } from "./helpers/draw-payload";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RichText } from "@promptctl/rich-js";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { registerDslConfig } from "../src/dsl/render";
import { processLauncher } from "../src/proc/launch";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { checkoutLocation } from "../src/utils/git-root";
import { instantOf } from "../src/utils/instant";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { TEST_SIGNER } from "./helpers/link-signer";
import { parseAndValidate } from "./helpers/parse-and-validate";

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

function draw(payload: Record<string, unknown>, variables: object = {}): string {
  const config = parseAndValidate(
    "<user>",
    JSON.stringify({ variables, root: { h: ["gitaculous"] } }),
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  const sink = new Map<string, readonly RichText[]>();
  try {
    const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
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
  return (sink.get("gitaculous") ?? []).map((t) => t.plain).join("").trim();
}

describe("gitaculous location", () => {
  const MAIN = "/home/me/projects/cc-candybar";
  const located = (worktree: string, subpath: string) => ({
    cwd: `/home/me/projects/cc-candybar/.claude/worktrees/x${subpath}`,
    location: { main: MAIN, worktree, subpath, gitPending: false },
    git: { branch: "main" },
  });

  test("main checkout has no parenthetical", () => {
    expect(draw(located("", ""))).toBe("~/p/cc-candybar ⎇ main ▸");
  });
  test("linked worktree is named", () => {
    expect(draw(located("jumping", ""))).toBe("~/p/cc-candybar (⊫ jumping) ⎇ main ▸");
  });
  test("worktree subdirectory keeps the subpath", () => {
    expect(draw(located("jumping", "/src"))).toBe("~/p/cc-candybar/src (⊫ jumping) ⎇ main ▸");
  });
  test("no repo shows the plain path and init", () => {
    expect(
      draw({ workspace: { current_dir: "/home/me/scratch/notes" }, location: { main: "", worktree: "", subpath: "", noRepo: true, gitPending: false } }),
    ).toBe("~/s/notes init");
  });
  test("the path stays while git is loading", () => {
    expect(
      draw({ ...located("jumping", ""), git: undefined, location: { main: MAIN, worktree: "jumping", subpath: "", gitPending: true } }),
    ).toBe("~/p/cc-candybar (⊫ jumping)");
  });
});

test("a directory with no repo beside a live git answer keeps the git state", () => {
  expect(
    draw({
      workspace: { current_dir: "/tmp/x" },
      location: { main: "", worktree: "", subpath: "", noRepo: true, gitPending: false },
      git: { branch: "main" },
    }),
  ).toBe("/t/x ⎇ main ▸ init");
});

test("git.location repo restores the repo name in expanded and drops the path", () => {
  const out = draw(
    { git: { branch: "main", repoName: "repo" }, location: { main: "/r", worktree: "", subpath: "", noRepo: false, gitPending: false } },
    { "git.location": { kind: "literal", value: "repo" }, "git.detail": { kind: "state", key: "git-detail", default: "expanded" } },
  );
  expect(out).toContain("(git) repo ");
});
