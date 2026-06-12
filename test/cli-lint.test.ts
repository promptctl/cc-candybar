// [LAW:verifiable-goals] lint's contract is its OUTCOME, discriminated by kind —
// valid / invalid / unreadable. `lintConfig` is the pure decision (a function of
// the file's contents); `runLint` projects it to stdout/stderr + exit code. We
// assert the decision directly, so the exit-code contract is verifiable without
// spawning a process or stubbing process.exit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lintConfig } from "../src/config/cli";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-lint-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

describe("lintConfig", () => {
  it("reports a valid config", () => {
    const p = write(
      "ok.json5",
      `{ segments: { a: { template: 'a' } }, root: { h: ['a'] } }`,
    );
    expect(lintConfig(p)).toEqual({ kind: "valid", path: p });
  });

  it("reports a structurally invalid config with the loader's message", () => {
    const p = write("bad.json5", `{ segments: { a: { template: 42 } } }`);
    const outcome = lintConfig(p);
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") {
      expect(outcome.message).toContain("Invalid config");
      expect(outcome.message).toContain("template");
    }
  });

  it("reports a semantic (cross-ref) error — the daemon would surface the same", () => {
    const p = write(
      "dangling.json5",
      `{ segments: { a: { template: 'a' } }, root: { h: ['a', 'nope'] } }`,
    );
    const outcome = lintConfig(p);
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") {
      expect(outcome.message).toContain("nope");
    }
  });

  it("reports an unreadable file distinctly from an invalid one", () => {
    const outcome = lintConfig(path.join(dir, "does-not-exist.json5"));
    expect(outcome.kind).toBe("unreadable");
  });
});
