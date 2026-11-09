// What .claude/hooks/e2e-signoff.mjs refuses. One rule: an agent's edit to a
// guarded path is refused when origin/main already holds that path. A path main
// does not hold is free, so an agent can add the five end-to-end tests and the
// files a branch is still building, and after the merge every one of them is
// held. The hook file is a shim over this module so that, once merged, the logic
// is as guarded as the rest.
//
// The only effect is `mainHolds`, injected: it answers whether origin/main holds
// a repo-relative path, and throws when it cannot tell. [LAW:effects-at-boundaries]

const path = require("node:path");

const GUARDED_FILES = [".claude/e2e-signoff.json", ".claude/hooks/e2e-signoff.mjs"];
// The checks, their fixtures and tests, and the end-to-end tests themselves.
const GUARDED_DIRECTORIES = [
  "test/e2e-checks/",
  "test/unit/e2e-checks/",
  "test/integration/e2e-checks/",
  "test/e2e/",
];

const FILE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

// Running a test reads a guarded file and writes none.
// `ls` and `git add` write no file; staging a file main lacks stays free.
const READ_ONLY =
  /^\s*(?:(?:cat|less|head|tail|grep|rg|ls)\b|git (?:add|diff|log|show|status)\b|(?:pnpm|npx)(?:\s+-\S+)*\s+(?:exec\s+)?(?:jest|test\S*)|node\s+\S*jest\.js\b)/;
// A read-only command that writes anyway: a redirect, or `git diff --output=file`.
const WRITES_ANYWAY = />|--output/;

// The worktree an agent works in sits under the main checkout, and the hook may be
// handed the main checkout as its root; a guarded path is the same file in both.
const WORKTREE_PREFIX = /^\.claude\/worktrees\/[^/]+\//;

/** A path relative to the project root with forward slashes, or null outside it. */
function relativeTo(root, file) {
  const rel = path.relative(root, path.resolve(root, file));
  return rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
    ? null
    : rel.split(path.sep).join("/").replace(WORKTREE_PREFIX, "");
}

// A directory is guarded as the directory itself too: `rm -rf test/e2e-checks` names no file inside it.
function isGuarded(rel) {
  return (
    GUARDED_FILES.includes(rel) ||
    GUARDED_DIRECTORIES.some((dir) => rel === dir.slice(0, -1) || rel.startsWith(dir))
  );
}

/**
 * The paths a Bash command writes or might write: those named by a segment that is
 * not read-only. Tokens split on quotes, parentheses, commas and `=` as well as
 * space, so a path inside `python -c "open('.claude/e2e-signoff.json', 'w')"` is seen.
 * Commands separated by `&`, `;`, `|`, a newline, `$(` or a backtick are judged apart,
 * and a `cd` moves where the later relative names resolve. A path built by the
 * shell (`$VAR`, a glob) is not seen, and neither is the shell's cwd from an earlier call.
 * @returns absolute paths
 */
function pathsNamedByWrites(command, root) {
  let cwd = root;
  return command
    .replace(/\d*>&\d+/g, " ") // a descriptor redirect such as 2>&1 is no separator and no file write
    .replace(/\$\(|`/g, ";")
    .split(/&|\||;|\n/)
    .flatMap((segment) => {
      const cd = /^\s*cd\s+["']?([^\s"']+)/.exec(segment);
      if (cd !== null) {
        cwd = path.resolve(cwd, cd[1]);
        return [];
      }
      if (READ_ONLY.test(segment) && !WRITES_ANYWAY.test(segment)) return [];
      return segment
        .split(/[\s"'`(),=<>]+/)
        .filter((token) => token !== "")
        .map((token) => path.resolve(cwd, token));
    });
}

/**
 * @param {{ tool: string, input: Record<string, unknown>, root: string, mainHolds: (rel: string) => boolean }} call
 * @returns {string | null} why the call is refused, or null
 */
function refusalOf({ tool, input, root, mainHolds }) {
  const named = FILE_TOOLS.includes(tool)
    ? [String(input.file_path ?? input.notebook_path ?? "")]
    : tool === "Bash"
      ? pathsNamedByWrites(String(input.command ?? ""), root)
      : [];
  // Each distinct guarded path is asked of origin/main once: the probe spawns git.
  const guarded = new Set(
    named
      .filter((file) => file !== "")
      .map((file) => relativeTo(root, file))
      .filter((rel) => rel !== null && isGuarded(rel)),
  );
  const held = [...guarded].find((rel) => mainHolds(rel));
  return held === undefined
    ? null
    : `${held} is held by origin/main and guarded: it sets or checks the end-to-end cap and assertion limit, ` +
        "and only Brandon changes it. Tell him what you needed instead.";
}

module.exports = { refusalOf, isGuarded };
