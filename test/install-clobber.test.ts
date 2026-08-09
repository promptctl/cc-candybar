import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { __test__ } from "../src/install";

const {
  updateClaudeSettings,
  buildStatusLineCommand,
  DEFAULT_INSTALL_ARGS,
  shellEscape,
  stageFile,
  stagedEntryKind,
  resolveRenderEntry,
  installSuccessMessage,
} = __test__;

// Every temp dir is registered here and removed once after the whole file, so
// tests stay free to create as many as they need without leaking into /tmp.
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function mkTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// A realistic staged path — the space in "Application Support" exercises the
// quoting the real darwin path needs.
const BIN = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "CCCandybar",
  "bin",
  "cc-candybar",
);

function tmpSettingsPath(): string {
  return path.join(mkTmpDir("cpwl-install-test-"), "settings.json");
}

function readCommand(settingsPath: string): string | undefined {
  if (!fs.existsSync(settingsPath)) return undefined;
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  return s.statusLine?.command;
}

describe("buildStatusLineCommand", () => {
  test("quotes a bin path containing spaces", () => {
    const cmd = buildStatusLineCommand(BIN, []);
    expect(cmd).toBe(shellEscape(BIN));
    expect(cmd).toContain("'");
  });

  test("appends renderer args, each escaped", () => {
    const cmd = buildStatusLineCommand("/opt/bin/cc-candybar", [
      "--style=minimal",
      "weird arg",
    ]);
    expect(cmd).toBe("/opt/bin/cc-candybar --style=minimal 'weird arg'");
  });
});

describe("install — clobber protection", () => {
  test("fresh install writes the staged bin command", () => {
    const p = tmpSettingsPath();
    updateClaudeSettings(BIN, DEFAULT_INSTALL_ARGS, false, p);
    expect(readCommand(p)).toBe(buildStatusLineCommand(BIN, []));
  });

  test("re-install overwrites our own prior command (version upgrade)", () => {
    const p = tmpSettingsPath();
    updateClaudeSettings(BIN, ["--style=minimal"], false, p);
    expect(readCommand(p)).toContain("--style=minimal");

    updateClaudeSettings(BIN, ["--style=powerline"], false, p);
    expect(readCommand(p)).toContain("--style=powerline");
  });

  test("legacy pnpm-dlx command is recognized as ours and upgraded", () => {
    const p = tmpSettingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        statusLine: {
          type: "command",
          command: "pnpm dlx @promptctl/cc-candybar@1.17.5",
        },
      }),
    );

    updateClaudeSettings(BIN, DEFAULT_INSTALL_ARGS, false, p);
    expect(readCommand(p)).toBe(buildStatusLineCommand(BIN, []));
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
    updateClaudeSettings(BIN, DEFAULT_INSTALL_ARGS, false, p);
    process.stderr.write = origWrite;

    expect(readCommand(p)).toBe(
      "/usr/local/bin/my-custom-renderer --theme=nord",
    );
    expect(stderr.join("")).toContain("customized");
    expect(stderr.join("")).toContain("--force");
  });

  test("a path-superset command (ours + suffix) is NOT claimed as ours", () => {
    const p = tmpSettingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Bare (unquoted) path whose string is a superset of the staged bin path:
    // startsWith would match; the token-boundary rule must not.
    const bareBin = "/opt/bin/cc-candybar";
    fs.writeFileSync(
      p,
      JSON.stringify({
        statusLine: { type: "command", command: `${bareBin}-backup --mine` },
      }),
    );

    const stderr: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Buffer) => {
      stderr.push(String(chunk));
      return true;
    };
    updateClaudeSettings(bareBin, DEFAULT_INSTALL_ARGS, false, p);
    process.stderr.write = origWrite;

    expect(readCommand(p)).toBe(`${bareBin}-backup --mine`);
    expect(stderr.join("")).toContain("customized");
  });

  test("our bare command followed by args is still recognized as ours", () => {
    const p = tmpSettingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const bareBin = "/opt/bin/cc-candybar";
    fs.writeFileSync(
      p,
      JSON.stringify({
        statusLine: { type: "command", command: `${bareBin} --style=minimal` },
      }),
    );

    updateClaudeSettings(bareBin, DEFAULT_INSTALL_ARGS, false, p);
    expect(readCommand(p)).toBe(buildStatusLineCommand(bareBin, []));
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

    updateClaudeSettings(BIN, DEFAULT_INSTALL_ARGS, true, p);
    expect(readCommand(p)).toBe(buildStatusLineCommand(BIN, []));
  });

  test("empty settings.json gets statusLine written", () => {
    const p = tmpSettingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{}");

    updateClaudeSettings(BIN, DEFAULT_INSTALL_ARGS, false, p);
    expect(readCommand(p)).toBe(buildStatusLineCommand(BIN, []));
  });

  test("settings without statusLine gets statusLine written", () => {
    const p = tmpSettingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ someOtherKey: true }));

    updateClaudeSettings(BIN, DEFAULT_INSTALL_ARGS, false, p);
    expect(readCommand(p)).toBe(buildStatusLineCommand(BIN, []));
  });
});

describe("installSuccessMessage", () => {
  test("mentions the settings drawer and theme/look picker on the default bar", () => {
    const msg = installSuccessMessage();
    expect(msg).toMatch(/theme\/look picker/i);
    expect(msg).toContain("⚙ settings");
  });
});

describe("resolveRenderEntry", () => {
  test("resolves the native binary from node_modules beside the dist", () => {
    // The repo checkout installs every platform package (workspace-yaml
    // supportedArchitectures), so the current platform's is always present.
    const sourceDist = path.resolve(__dirname, "..", "dist", "index.mjs");
    const entry = resolveRenderEntry(sourceDist);
    expect(entry.kind).toBe("native");
    expect(entry.sourcePath).toContain(
      `cc-candybar-${process.platform}-${process.arch}`,
    );
    expect(fs.existsSync(entry.sourcePath)).toBe(true);
  });

  test("falls back to the sibling node shim when no platform package resolves", () => {
    const dir = mkTmpDir("cpwl-entry-test-");
    fs.mkdirSync(path.join(dir, "dist"));
    const entry = resolveRenderEntry(path.join(dir, "dist", "index.mjs"));
    expect(entry.kind).toBe("node-shim");
    expect(entry.sourcePath).toBe(path.join(dir, "bin", "cc-candybar"));
  });
});

describe("stagedEntryKind", () => {
  test("a '#!' script is the node shim", () => {
    const dir = mkTmpDir("cpwl-kind-test-");
    const f = path.join(dir, "cc-candybar");
    fs.writeFileSync(f, "#!/usr/bin/env node\nimport('../dist/index.mjs');\n");
    expect(stagedEntryKind(f)).toBe("node-shim");
  });

  test("a truncated (<2 byte) file throws instead of passing as native", () => {
    const dir = mkTmpDir("cpwl-kind-test-");
    const f = path.join(dir, "cc-candybar");
    fs.writeFileSync(f, "#");
    expect(() => stagedEntryKind(f)).toThrow(/truncated/);
  });

  test("a binary (non-shebang) file is native", () => {
    const dir = mkTmpDir("cpwl-kind-test-");
    const f = path.join(dir, "cc-candybar");
    // Mach-O 64-bit magic — what a previously staged Rust binary starts with.
    fs.writeFileSync(f, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00]));
    expect(stagedEntryKind(f)).toBe("native");
  });
});

describe("stageFile", () => {
  test("copies source to dest", () => {
    const dir = mkTmpDir("cpwl-stage-test-");
    const src = path.join(dir, "src.bin");
    const dest = path.join(dir, "dest.bin");
    fs.writeFileSync(src, "payload");
    stageFile(src, dest);
    expect(fs.readFileSync(dest, "utf-8")).toBe("payload");
  });

  test("identity staging is a no-op, never a truncation", () => {
    const dir = mkTmpDir("cpwl-stage-test-");
    const f = path.join(dir, "same.bin");
    fs.writeFileSync(f, "payload");
    // Same file reached through a dot-dot detour — must not truncate it.
    stageFile(f, path.join(dir, "..", path.basename(dir), "same.bin"));
    expect(fs.readFileSync(f, "utf-8")).toBe("payload");
  });
});
