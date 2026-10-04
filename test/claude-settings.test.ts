// The client's resolution of CLAUDE_CONFIG_DIR into the `claudeConfigDir`
// hint — the same cases the Rust client's
// claude_config_dir_hint_resolves_the_first_entry_against_cwd pins, so the two
// runtimes report one directory for one session.

import os from "node:os";
import path from "node:path";
import {
  CLAUDE_CONFIG_DIR_ENV,
  claudeConfigDir,
  detectClaudeConfigDir,
} from "../src/claude-settings";
import { parseClientHints } from "../src/daemon/protocol";

const hint = (raw: string | undefined) =>
  detectClaudeConfigDir({ [CLAUDE_CONFIG_DIR_ENV]: raw }, "/work/proj");

test("the first entry, absolute against the client's cwd; blank is the default", () => {
  expect(hint(undefined)).toBeUndefined();
  expect(hint("")).toBeUndefined();
  expect(hint(" ,/b")).toBeUndefined();
  expect(hint("/home/u/.claude-work")).toBe("/home/u/.claude-work");
  expect(hint(" /a , /b")).toBe("/a");
  expect(hint(".claude-work")).toBe("/work/proj/.claude-work");
  expect(hint("../x/./y/")).toBe("/work/x/y");
});

test("the daemon takes only an absolute directory; none is ~/.claude", () => {
  expect(parseClientHints({ claudeConfigDir: "/a" }).claudeConfigDir).toBe("/a");
  expect(parseClientHints({ claudeConfigDir: ".claude" }).claudeConfigDir).toBeUndefined();
  expect(parseClientHints({ claudeConfigDir: 7 }).claudeConfigDir).toBeUndefined();
  expect(claudeConfigDir(undefined)).toBe(path.join(os.homedir(), ".claude"));
});
