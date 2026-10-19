// brandon-plugins-ktag.e2d: `cc-candybar plugin install <source>` copies a
// repository's `.cc-candybar/plugins/<name>/plugin.json5` folders into the
// user's plugin root, from a local path, a GitHub slug, or a git URL.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  installFromRepo,
  parsePluginSource,
  runPlugin,
} from "../src/plugin-install";

const DEFINITION = `{ data: { checkout: ".app/state.json" }, segments: { status: { description: "the app's status", template: '{{ .plugins.app.data.status }}' } } }`;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-plugin-install-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function repoWith(plugins: Record<string, string>): string {
  const repo = path.join(dir, "repo");
  for (const [name, text] of Object.entries(plugins)) {
    fs.mkdirSync(path.join(repo, ".cc-candybar/plugins", name), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repo, ".cc-candybar/plugins", name, "plugin.json5"),
      text,
    );
  }
  fs.mkdirSync(repo, { recursive: true });
  return repo;
}

describe("parsePluginSource", () => {
  const isDir = (dirs: string[]) => (p: string) => dirs.includes(p);

  test.each([
    ["owner/repo", "https://github.com/owner/repo.git"],
    [
      "promptctl/links-issue-tracker",
      "https://github.com/promptctl/links-issue-tracker.git",
    ],
    ["https://example.com/app.git", "https://example.com/app.git"],
    ["file:///srv/app", "file:///srv/app"],
    ["git@github.com:owner/repo.git", "git@github.com:owner/repo.git"],
  ])("%s is the git repo %s", (arg, url) => {
    expect(parsePluginSource(arg, "/cwd", isDir([]))).toEqual({
      kind: "git",
      url,
    });
  });

  test("a directory that exists is a path, even one spelled like a slug", () => {
    expect(
      parsePluginSource("owner/repo", "/cwd", isDir(["/cwd/owner/repo"])),
    ).toEqual({
      kind: "path",
      dir: "/cwd/owner/repo",
    });
  });

  test("anything else names nothing, and says so", () => {
    expect(parsePluginSource("./nowhere/at/all", "/cwd", isDir([]))).toEqual({
      error: `"./nowhere/at/all" is not a directory, a GitHub repo slug (owner/repo) or a git URL`,
    });
  });
});

describe("installFromRepo", () => {
  test("installs each folder's definition into the root, and a re-run updates it", () => {
    const root = path.join(dir, "plugins");
    const repo = repoWith({ app: DEFINITION });
    expect(installFromRepo(repo, root, "repo")).toEqual([
      path.join(root, "app/plugin.json5"),
    ]);
    expect(fs.readFileSync(path.join(root, "app/plugin.json5"), "utf8")).toBe(
      DEFINITION,
    );

    const updated = DEFINITION.replace("the app's status", "updated");
    fs.writeFileSync(
      path.join(repo, ".cc-candybar/plugins/app/plugin.json5"),
      updated,
    );
    installFromRepo(repo, root, "repo");
    expect(fs.readFileSync(path.join(root, "app/plugin.json5"), "utf8")).toBe(
      updated,
    );
    // Nothing staged is left behind beside the plugin.
    expect(fs.readdirSync(root)).toEqual(["app"]);
    expect(fs.readdirSync(path.join(root, "app"))).toEqual(["plugin.json5"]);
  });

  test("a plugin folder that is a link is replaced, never written through", () => {
    const root = path.join(dir, "plugins");
    const work = path.join(dir, "work");
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, "plugin.json5"), "// my edits");
    fs.mkdirSync(root);
    fs.symlinkSync(work, path.join(root, "app"));
    installFromRepo(repoWith({ app: DEFINITION }), root, "repo");
    expect(fs.readFileSync(path.join(work, "plugin.json5"), "utf8")).toBe(
      "// my edits",
    );
    expect(fs.lstatSync(path.join(root, "app")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(root, "app/plugin.json5"), "utf8")).toBe(
      DEFINITION,
    );
    expect(fs.readdirSync(root)).toEqual(["app"]);
  });

  test("a definition the loader would drop installs nothing, and names why", () => {
    const root = path.join(dir, "plugins");
    const repo = repoWith({
      app: DEFINITION,
      broken: `{ segments: { s: { template: '{{ .plugins.broken.data.x }}' } }, shell: "rm -rf /" }`,
    });
    expect(() => installFromRepo(repo, root, "repo")).toThrow(
      /^repo: \.cc-candybar\/plugins\/broken\/plugin\.json5 would not load: .*shell/,
    );
    expect(fs.readdirSync(root)).toEqual([]);
  });

  test("a repo with no plugins is an error, never an empty install", () => {
    expect(() =>
      installFromRepo(repoWith({}), path.join(dir, "plugins"), "repo"),
    ).toThrow(
      /has no plugins: none at \.cc-candybar\/plugins\/<name>\/plugin\.json5/,
    );
  });
});

describe("runPlugin", () => {
  const saved = process.env.XDG_DATA_HOME;
  let log: jest.SpyInstance;
  let err: jest.SpyInstance;
  beforeEach(() => {
    process.env.XDG_DATA_HOME = path.join(dir, "data");
    log = jest.spyOn(console, "log").mockImplementation(() => {});
    err = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
    log.mockRestore();
    err.mockRestore();
  });

  test("clones a git URL and installs from it into $XDG_DATA_HOME", () => {
    const repo = repoWith({ app: DEFINITION });
    fs.writeFileSync(path.join(repo, "README"), "not a plugin");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
    const url = `file://${repo}`;

    expect(runPlugin(["install", url])).toBe(0);
    const installed = path.join(
      dir,
      "data/cc-candybar/plugins/app/plugin.json5",
    );
    expect(fs.readFileSync(installed, "utf8")).toBe(DEFINITION);
    expect(log).toHaveBeenCalledWith(
      `installed plugin app → ${installed} (from ${url})`,
    );
  });

  test("a git repo without the plugins folder fails, naming it", () => {
    const repo = repoWith({});
    fs.writeFileSync(path.join(repo, "README"), "x");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
    expect(runPlugin(["install", `file://${repo}`])).toBe(1);
    expect(err.mock.calls[0]![0]).toMatch(
      /plugin install: git .*\.cc-candybar\/plugins.*failed/s,
    );
  });

  test.each([[[]], [["install"]], [["remove", "x"]], [["install", "a", "b"]]])(
    "%j is a usage error",
    (argv) => {
      expect(runPlugin(argv)).toBe(2);
      expect(err).toHaveBeenCalledWith(
        "Usage: cc-candybar plugin install <path | owner/repo | git URL>",
      );
    },
  );
});
