// `cc-candybar plugin install <source>`: copy a repository's plugins into the
// user's plugin root. The source is a local path, a GitHub repo slug, or a
// URL of a git repo; the plugins are the folders under its
// `.cc-candybar/plugins/` (REPO_PLUGIN_DIR), each holding a plugin.json5.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_DSL_CONFIG } from "./config/default-dsl-config.js";
import { definitionProblems } from "./config/dsl-loader.js";
import {
  listFolders,
  REPO_PLUGIN_DIR,
  userPluginRoot,
} from "./config/loader/plugin-folders.js";
import { DEFINITION_FILE } from "./config/loader/plugins.js";
import { launchSync } from "./proc/launch.js";
import { resolveUserPath } from "./utils/user-path.js";

// [LAW:types-are-the-program] What a source argument names, decided once.
export type PluginSource =
  | { readonly kind: "path"; readonly dir: string }
  | { readonly kind: "git"; readonly url: string };

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// git's scp-like form: `git@github.com:owner/repo.git`.
const SCP_LIKE = /^[^@\s/]+@[^:\s/]+:/;
const GITHUB_SLUG = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * A directory that exists is a path, whatever it looks like; then a URL; then
 * `owner/repo` on GitHub. Anything else names nothing, and says so.
 */
export function parsePluginSource(
  arg: string,
  cwd: string,
  isDirectory: (p: string) => boolean,
): PluginSource | { readonly error: string } {
  const dir = resolveUserPath(cwd, arg);
  if (isDirectory(dir)) return { kind: "path", dir };
  if (URL_SCHEME.test(arg) || SCP_LIKE.test(arg))
    return { kind: "git", url: arg };
  if (GITHUB_SLUG.test(arg))
    return { kind: "git", url: `https://github.com/${arg}.git` };
  return {
    error: `"${arg}" is not a directory, a GitHub repo slug (owner/repo) or a git URL`,
  };
}

// The plugins a repository holds: one definition per folder under
// REPO_PLUGIN_DIR. [LAW:no-silent-failure] No such directory, a file where a
// folder belongs, or a directory that cannot be listed is an error, never an
// empty install.
function repoDefinitions(repo: string): readonly string[] {
  const root = path.join(repo, REPO_PLUGIN_DIR);
  const listed = listFolders(root);
  if ("error" in listed)
    throw new Error(`could not list ${root}: ${listed.error}`);
  if (listed.files.length > 0)
    throw new Error(
      `${root} holds files (${listed.files.join(", ")}): a plugin is a folder holding its ${DEFINITION_FILE}`,
    );
  if (listed.folders.length === 0)
    throw new Error(
      `${repo} has no plugins: none at ${REPO_PLUGIN_DIR}/<name>/${DEFINITION_FILE}`,
    );
  return listed.folders.map((name) => path.join(root, name, DEFINITION_FILE));
}

// [LAW:effects-at-boundaries] The one network edge: a shallow, blobless clone
// that checks out only REPO_PLUGIN_DIR. `--` keeps a source spelled like an
// option from being read as one.
function cloneRepo(url: string, into: string): void {
  const git = (...args: string[]): void => {
    const run = launchSync({ bin: "git", args, category: "plugin.git" });
    if (!run.ok)
      throw new Error(
        `git ${args.join(" ")} failed (${run.reason}): ${run.stderr.trim() || run.error || ""}`,
      );
  };
  git(
    "clone",
    "--quiet",
    "--depth",
    "1",
    "--filter=blob:none",
    "--no-checkout",
    "--",
    url,
    into,
  );
  git("-C", into, "checkout", "--quiet", "HEAD", "--", REPO_PLUGIN_DIR);
}

// The source as a directory on disk for as long as `use` runs: a path is
// itself; a git repo is cloned into a temporary directory, removed after.
function withRepo<T>(source: PluginSource, use: (repo: string) => T): T {
  switch (source.kind) {
    case "path":
      return use(source.dir);
    case "git": {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-plugin-"));
      try {
        cloneRepo(source.url, path.join(dir, "repo"));
        return use(path.join(dir, "repo"));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}

// Put a staged plugin folder at `target`, replacing whatever is there — a
// folder, or a link to one, which is moved aside and never written through.
function place(staged: string, target: string, aside: string): void {
  try {
    fs.renameSync(target, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  fs.renameSync(staged, target);
}

/**
 * Install every plugin `repo` holds into `root`. Each definition is read
 * once, into a staging folder inside `root` (a dot-name, which no load
 * reads); the staged bytes are what the loader checks and what is installed,
 * and a definition it would drop installs nothing. `source` names the repo in
 * messages. Returns each installed path.
 */
// [LAW:no-ambient-temporal-coupling] The daemon watches `root`, so each
// plugin appears whole: its folder is renamed into place.
export function installFromRepo(
  repo: string,
  root: string,
  source: string,
): readonly string[] {
  const definitions = repoDefinitions(repo);
  fs.mkdirSync(root, { recursive: true });
  const stage = fs.mkdtempSync(path.join(root, ".install-"));
  try {
    const staged = definitions.map((d) => {
      const folder = path.join(stage, path.basename(path.dirname(d)));
      fs.mkdirSync(folder);
      fs.copyFileSync(d, path.join(folder, DEFINITION_FILE));
      return folder;
    });
    const problems = definitionProblems(
      staged.map((f) => path.join(f, DEFINITION_FILE)),
      DEFAULT_DSL_CONFIG,
      { root: repo, git: false },
    );
    if (problems.length > 0)
      throw new Error(
        problems
          .map(
            (p) =>
              `${source}: ${path.join(REPO_PLUGIN_DIR, path.relative(stage, p.path))} would not load: ${p.reason}`,
          )
          .join("\n"),
      );
    return staged.map((folder) => {
      const name = path.basename(folder);
      place(
        folder,
        path.join(root, name),
        path.join(stage, `.replaced-${name}`),
      );
      return path.join(root, name, DEFINITION_FILE);
    });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

const USAGE = "Usage: cc-candybar plugin install <path | owner/repo | git URL>";

// Exit 0 installed, 1 the source or a definition failed, 2 usage.
export function runPlugin(argv: readonly string[]): number {
  const [verb, arg, ...rest] = argv;
  if (verb !== "install" || arg === undefined || rest.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const source = parsePluginSource(arg, process.cwd(), (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  if ("error" in source) {
    console.error(`plugin install: ${source.error}`);
    return 2;
  }
  try {
    const from = source.kind === "path" ? source.dir : source.url;
    const installed = withRepo(source, (repo) =>
      installFromRepo(repo, userPluginRoot(), from),
    );
    for (const p of installed)
      console.log(
        `installed plugin ${path.basename(path.dirname(p))} → ${p} (from ${from})`,
      );
    return 0;
  } catch (e) {
    console.error(`plugin install: ${(e as Error).message}`);
    return 1;
  }
}
