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

// [LAW:one-source-of-truth] exception: release-pin.mjs's read-only list, copied.
// That hook runs on import and exports nothing, and its file is under its own
// pin, so this cannot import it. Running a test reads a guarded file and writes none.
// `cd`, `ls` and `git add` write no file; staging a file main lacks stays free.
const READ_ONLY =
  /^\s*(?:(?:cat|less|head|tail|grep|rg|ls|cd)\b|git (?:add|diff|log|show|status)\b|(?:pnpm|npx)(?:\s+-\S+)*\s+(?:exec\s+)?(?:jest|test\S*)|node\s+\S*jest\.js\b)/;

// The worktree an agent works in sits under the main checkout, and the hook may be
// handed the main checkout as its root; a guarded path is the same file in both.
const WORKTREE_PREFIX = /^\.claude\/worktrees\/[^/]+\//;

/** A path relative to the project root with forward slashes, or null outside it. */
function relativeTo(root, file) {
  const rel = path.relative(root, path.resolve(root, file));
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel)
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
 * A path built by the shell (`cd` then a relative name, `$VAR`, a glob) is not.
 */
function pathsNamedByWrites(command) {
  return command
    .split(/&&|\|\||;|\||\n/)
    .filter((segment) => !READ_ONLY.test(segment) || segment.includes(">"))
    .flatMap((segment) => segment.split(/[\s"'`(),=<>]+/));
}

/**
 * @param {{ tool: string, input: Record<string, unknown>, root: string, mainHolds: (rel: string) => boolean }} call
 * @returns {string | null} why the call is refused, or null
 */
function refusalOf({ tool, input, root, mainHolds }) {
  const named = FILE_TOOLS.includes(tool)
    ? [String(input.file_path ?? input.notebook_path ?? "")]
    : tool === "Bash"
      ? pathsNamedByWrites(String(input.command ?? ""))
      : [];
  const held = named
    .filter((file) => file !== "")
    .map((file) => relativeTo(root, file))
    .filter((rel) => rel !== null && isGuarded(rel))
    .find((rel) => mainHolds(rel));
  return held === undefined
    ? null
    : `${held} is held by origin/main and guarded: it sets or checks the end-to-end cap and assertion limit, ` +
        "and only Brandon changes it. Tell him what you needed instead.";
}

module.exports = { refusalOf, isGuarded };
