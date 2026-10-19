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
import {
  DEFINITION_FILE,
  droppedPluginNotice,
} from "./config/loader/plugins.js";
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
// that checks out only REPO_PLUGIN_DIR.
function cloneRepo(url: string, into: string): void {
  const git = (...args: string[]): void => {
    const run = launchSync({ bin: "git", args, category: "plugin.git" });
    if (!run.ok)
      throw new Error(
        `git ${args.join(" ")} failed (${run.reason}): ${run.stderr.trim()}`,
      );
  };
  git(
    "clone",
    "--quiet",
    "--depth",
    "1",
    "--filter=blob:none",
    "--no-checkout",
    url,
    into,
  );
  git("-C", into, "checkout", "--quiet", "HEAD", "--", REPO_PLUGIN_DIR);
}

// [LAW:no-ambient-temporal-coupling] The daemon watches the root, so a plugin
// appears whole: a new folder is staged under a dot-name (never loaded) and
// renamed into place; an existing one has its definition replaced by rename.
function installDefinition(definition: string, root: string): string {
  const name = path.basename(path.dirname(definition));
  const target = path.join(root, name);
  const bytes = fs.readFileSync(definition);
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(target)) {
    const tmp = path.join(target, `.${DEFINITION_FILE}.${process.pid}`);
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, path.join(target, DEFINITION_FILE));
  } else {
    const staged = path.join(root, `.${name}.${process.pid}`);
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(staged);
    fs.writeFileSync(path.join(staged, DEFINITION_FILE), bytes);
    fs.renameSync(staged, target);
  }
  return path.join(target, DEFINITION_FILE);
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

/**
 * Install every plugin `repo` holds into `root`, or none: a definition the
 * loader would drop refuses the whole install. Returns each installed path.
 */
export function installFromRepo(repo: string, root: string): readonly string[] {
  const definitions = repoDefinitions(repo);
  const problems = definitionProblems(definitions, DEFAULT_DSL_CONFIG, {
    root: repo,
    git: false,
  });
  if (problems.length > 0)
    throw new Error(problems.map(droppedPluginNotice).join("\n"));
  return definitions.map((d) => installDefinition(d, root));
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
    const installed = withRepo(source, (repo) =>
      installFromRepo(repo, userPluginRoot()),
    );
    for (const p of installed)
      console.log(
        `installed plugin ${path.basename(path.dirname(p))} → ${p} (from ${arg})`,
      );
    return 0;
  } catch (e) {
    console.error(`plugin install: ${(e as Error).message}`);
    return 1;
  }
}
