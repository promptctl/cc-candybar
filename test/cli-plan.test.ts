// [LAW:verifiable-goals] The contract of a one-shot command's delivery: what
// the plan says reaches a piped reader whole, and the process ends with the
// plan's code. The failure this pins is a `process.exit` that outruns an
// asynchronous pipe — macOS drops everything past the first 64 KiB
// (brandon-unfiled-3248.6di0). Linux pipes are synchronous, so there the
// test cannot fail; it is the contract, pinned where it can break.

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CHILD = path.join(__dirname, "fixtures", "cli-plan-child.ts");

// Past one pipe buffer (64 KiB) by a margin, so the tail is what an early exit
// would lose.
const BODY_BYTES = 200_000;

const deliver = (bytes: number, code: number, env = process.env) =>
  // The sandbox env carries the version stamp test/setup.ts threads through
  // NODE_OPTIONS; the default would be the worker's own, which does not.
  spawnSync(TSX, [CHILD, String(bytes), String(code)], {
    encoding: "utf8",
    env,
    maxBuffer: 4 * BODY_BYTES,
  });

test("a body larger than a pipe buffer reaches a piped reader whole, and the exit code is the plan's", () => {
  const r = deliver(BODY_BYTES, 0);
  expect(r.status).toBe(0);
  expect(r.stdout).toHaveLength(BODY_BYTES);
  expect(r.stdout.endsWith("\n")).toBe(true);
  // tsx adds a deprecation line of its own after the plan's.
  expect(r.stderr.startsWith("advisory\n")).toBe(true);
});

test("a non-zero plan exits non-zero after its body is through", () => {
  const r = deliver(BODY_BYTES, 3);
  expect(r.status).toBe(3);
  expect(r.stdout).toHaveLength(BODY_BYTES);
});

test("the delivery is recorded on the debug channel", () => {
  const r = deliver(10, 0, { ...process.env, CC_CANDYBAR_DEBUG: "1" });
  expect(r.stderr).toContain("[DEBUG] delivered stdout=10 stderr=9 code=0");
});

// `| head`: the reader hangs up before the body is through. That ends the
// delivery as SIGPIPE ends any other writer — the plan's code, no stack trace.
test("a reader that hangs up ends the delivery with the plan's code", async () => {
  const child = spawn(TSX, [CHILD, String(BODY_BYTES), "0"], {
    env: process.env,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (t: string) => (stderr += t));
  await new Promise<void>((resolve) =>
    child.stdout.once("data", () => {
      child.stdout.destroy();
      resolve();
    }),
  );
  const code = await new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  expect(code).toBe(0);
  expect(stderr).not.toContain("EPIPE");
});
