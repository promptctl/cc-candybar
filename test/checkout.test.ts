import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkoutAt } from "./helpers/checkout";

// A hook exports its own worktree and index to the suite. Initializing a
// fixture from that environment must commit in the new checkout.
test("a fixture checkout cannot commit into its caller's repository", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "ccb-checkout-"));
  try {
    const caller = path.join(scratch, "caller");
    const fixture = path.join(scratch, "fixture");
    mkdirSync(caller);
    mkdirSync(fixture);
    checkoutAt(caller, "caller");
    const head = (cwd: string) =>
      execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
    const original = head(caller);
    execFileSync(
      process.execPath,
      [
        "--require",
        "tsx/cjs",
        "-e",
        "require(process.argv[1]).checkoutAt(process.argv[2], 'fixture')",
        require.resolve("./helpers/checkout"),
        fixture,
      ],
      {
        env: {
          ...process.env,
          GIT_DIR: path.join(caller, ".git"),
          GIT_WORK_TREE: caller,
          GIT_INDEX_FILE: path.join(caller, ".git", "index"),
        },
      },
    );
    expect(head(caller)).toBe(original);
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: fixture,
        encoding: "utf8",
      }).trim(),
    ).toBe("fixture");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
