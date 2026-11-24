// `cc-candybar <subcommand>` (src/index.ts SUBCOMMANDS): a positional argument
// names a handler, and one naming none is refused rather than read as a
// statusline render; the render takes flags only.

import { spawnSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const ENTRY = path.join(REPO_ROOT, "src", "index.ts");

const run = (args: readonly string[]) =>
  // The sandbox env carries the version stamp test/setup.ts threads through
  // NODE_OPTIONS; the default would be the worker's own, which does not.
  spawnSync(TSX, [ENTRY, ...args], {
    encoding: "utf8",
    input: "",
    env: process.env,
  });

test.each(["nope", "check", "lint"])(
  "unknown subcommand %s is refused with exit 2",
  (name) => {
    const r = run([name]);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(
      `cc-candybar: unknown subcommand "${name}" — see --help\n`,
    );
  },
);

test("an unknown subcommand is refused before --help, so the help it would print never hides the mistake", () => {
  // `follow` is the native client's (rust-client/src/main.rs NATIVE_SUBCOMMANDS):
  // under the Node shim it names nothing here.
  const r = run(["follow", "--help"]);
  expect(r.status).toBe(2);
  expect(r.stdout).toBe("");
  expect(r.stderr).toMatch(/unknown subcommand "follow"/);
});

test("a known subcommand reaches its handler", () => {
  const r = run(["frames"]);
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/--lane needs one of/);
});

test("a flags-only invocation is still the statusline render", () => {
  // Empty stdin: the render path's own failure, never the subcommand refusal.
  const r = run(["--config", "/nonexistent.json5"]);
  expect(r.stderr).not.toMatch(/unknown subcommand/);
  expect(r.stderr).toMatch(/^cc-candybar statusline: /m);
});
