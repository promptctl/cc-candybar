import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { __test__ } from "../src/install";

const { updateClaudeSettings, buildStatusLineCommand, DEFAULT_INSTALL_ARGS } =
  __test__;

function tmpSettingsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpwl-install-test-"));
  return path.join(dir, "settings.json");
}

function readCommand(settingsPath: string): string | undefined {
  if (!fs.existsSync(settingsPath)) return undefined;
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  return s.statusLine?.command;
}

describe("install — clobber protection", () => {
  test("fresh install writes statusLine.command", () => {
    const p = tmpSettingsPath();
    updateClaudeSettings(DEFAULT_INSTALL_ARGS, false, p);
    expect(readCommand(p)).toMatch(
      /pnpm dlx @promptctl\/claude-powerline@/,
    );
  });

  test("re-install overwrites our own prior command (version upgrade)", () => {
    const p = tmpSettingsPath();
    updateClaudeSettings(["--style=minimal"], false, p);
    expect(readCommand(p)).toContain("--style=minimal");

    updateClaudeSettings(["--style=powerline"], false, p);
    expect(readCommand(p)).toContain("--style=powerline");
  });

  test("refuses to overwrite user-customized command", () => {
    const p = tmpSettingsPath();
    // Write a non-standard command manually.
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        statusLine: {
          type: "command",
          command: "/usr/local/bin/my-custom-renderer --theme=nord",
        },
      }),
    );

    // Should refuse and leave the file unchanged.
    const stderr: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Buffer) => {
      stderr.push(String(chunk));
      return true;
    };
    updateClaudeSettings(DEFAULT_INSTALL_ARGS, false, p);
    process.stderr.write = origWrite;

    expect(readCommand(p)).toBe(
      "/usr/local/bin/my-custom-renderer --theme=nord",
    );
    expect(stderr.join("")).toContain("customized");
    expect(stderr.join("")).toContain("--force");
  });

  test("--force overwrites user-customized command", () => {
    const p = tmpSettingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        statusLine: {
          type: "command",
          command: "/usr/local/bin/my-custom-renderer --theme=nord",
        },
      }),
    );

    updateClaudeSettings(DEFAULT_INSTALL_ARGS, true, p);
    expect(readCommand(p)).toMatch(
      /pnpm dlx @promptctl\/claude-powerline@/,
    );
  });

  test("empty settings.json gets statusLine written", () => {
    const p = tmpSettingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{}");

    updateClaudeSettings(DEFAULT_INSTALL_ARGS, false, p);
    expect(readCommand(p)).toMatch(
      /pnpm dlx @promptctl\/claude-powerline@/,
    );
  });

  test("settings without statusLine gets statusLine written", () => {
    const p = tmpSettingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ someOtherKey: true }));

    updateClaudeSettings(DEFAULT_INSTALL_ARGS, false, p);
    expect(readCommand(p)).toMatch(
      /pnpm dlx @promptctl\/claude-powerline@/,
    );
  });
});
