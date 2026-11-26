import fs from "node:fs";
import { DOOR_GLYPH } from "../src/config/disclosure";
import path from "node:path";
import os from "node:os";
import { __test__ } from "../src/install";
import { PLATFORM_PACKAGES } from "../src/install/platforms";
import { shellWord } from "../src/shell-word";

const {
  planSettings,
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
  "/Users/u",
  "Library",
  "Application Support",
  "CCCandybar",
  "bin",
  "cc-candybar",
);

// The plan is pure over the text it is handed: the file is only named.
const FILE = "/Users/u/.claude/settings.json";

// What the install would write over `text`, or what it keeps.
function plan(text: string | null, force = false, bin = BIN) {
  return planSettings(FILE, text, bin, force).change;
}

function written(text: string | null, force = false, bin = BIN): string {
  const change = plan(text, force, bin);
  if (change.kind !== "set") throw new Error(`kept ${change.command}`);
  return change.text;
}

const settingsWith = (command: string, rest: object = {}) =>
  JSON.stringify({ ...rest, statusLine: { type: "command", command } });

describe("the statusLine command install writes", () => {
  test("is the staged entry alone, quoted where its path needs it", () => {
    expect(plan(null)).toMatchObject({ kind: "set", command: shellWord(BIN) });
    expect(shellWord(BIN)).toContain("'");
    expect(JSON.parse(written(null))).toEqual({
      statusLine: { type: "command", command: shellWord(BIN) },
    });
  });

  test.each([
    ["no file", null],
    ["a blank file", "  \n"],
    ["an empty object", "{}"],
    ["settings with no statusLine", JSON.stringify({ someOtherKey: true })],
  ])("%s gets the statusLine written", (_, text) => {
    expect(JSON.parse(written(text)).statusLine).toEqual({
      type: "command",
      command: shellWord(BIN),
    });
  });

  test("a re-install over the command it wrote changes nothing", () => {
    const text = settingsWith(shellWord(BIN));
    expect(written(text)).toBe(text);
  });

  test("the legacy pnpm-dlx command is recognized as ours and upgraded", () => {
    expect(
      JSON.parse(
        written(settingsWith("pnpm dlx @promptctl/cc-candybar@1.17.5")),
      ).statusLine.command,
    ).toBe(shellWord(BIN));
  });

  test("a single-quoted path an older quoter wrote is recognized as ours", () => {
    const bin = "/opt/c++@x/cc-candybar";
    expect(
      JSON.parse(written(settingsWith(`'${bin}'`), false, bin)).statusLine
        .command,
    ).toBe(bin);
  });

  // A command the install did not write is the user's, even one that runs the
  // staged entry with flags of their own after it.
  test.each([
    [
      "the legacy command with arguments",
      "pnpm dlx @promptctl/cc-candybar@1.17.5 --style=x",
    ],
    [
      "a legacy command with a shell suffix",
      "pnpm dlx @promptctl/cc-candybar@1.17.5|custom",
    ],
    ["another program", "/usr/local/bin/my-custom-renderer --theme=nord"],
    ["the entry with words after it", `${shellWord(BIN)} --style=minimal`],
    ["a path that only begins with the entry's", `${BIN}-backup --mine`],
  ])("%s is kept, and replaced only with --force", (_, command) => {
    expect(plan(settingsWith(command))).toEqual({ kind: "kept", command });
    expect(JSON.parse(written(settingsWith(command), true)).statusLine).toEqual(
      { type: "command", command: shellWord(BIN) },
    );
  });

  // brandon-effects-2gka.21e: the doctor's effectRefresh fix writes
  // `statusLine.refreshInterval`. Reinstalling changes only the command.
  test("a re-install keeps every other statusLine key and every other byte", () => {
    const legacy = "pnpm dlx @promptctl/cc-candybar@1.17.5";
    const before = `{
    "env": { "A": "1" },
    "statusLine": {
        "type": "command",
        "command": ${JSON.stringify(legacy)},
        "refreshInterval": 1,
        "padding": 2
    }
}
`;
    expect(written(before)).toBe(
      before.replace(JSON.stringify(legacy), JSON.stringify(shellWord(BIN))),
    );
  });
});

// [LAW:no-silent-failure] A settings file the install cannot read as Claude
// Code's is refused naming the file and what is wrong, with --force or not.
describe("a settings file that is not the shape install reads", () => {
  test.each([
    [
      "a statusLine of null",
      `{ "statusLine": null }`,
      "statusLine is null, not an object",
    ],
    [
      "a statusLine that is a string",
      `{ "statusLine": "cc-candybar" }`,
      `statusLine is "cc-candybar", not an object`,
    ],
    [
      "a statusLine that is a list",
      `{ "statusLine": [] }`,
      "statusLine is [], not an object",
    ],
    [
      "a command that is not a string",
      `{ "statusLine": { "command": 7 } }`,
      "statusLine.command is 7, not a string",
    ],
    ["a document that is not an object", "[1]", "not a JSON object"],
    ["text that is not JSON", "{ statusLine: 1 }", "cannot read"],
  ])("%s is refused", (_, text, why) => {
    for (const force of [false, true]) {
      expect(() => plan(text, force)).toThrow(`cannot read ${FILE}`);
      expect(() => plan(text, force)).toThrow(why);
    }
  });

  test("a key written twice, which JSON reads as its last, is refused naming the file", () => {
    expect(() =>
      plan(
        `{ "statusLine": { "command": "a" }, "statusLine": { "command": "b" } }`,
      ),
    ).toThrow(new RegExp(`cannot edit ${FILE}: .*statusLine`));
  });
});

describe("installSuccessMessage", () => {
  // Same contract as --help's own text (test/help-text.test.ts): the tip names
  // the surface the controls live on, with the glyph read from the synthesis
  // that renders it rather than spelled again here.
  test("points at the settings menu, with the glyph the bar actually renders", () => {
    const msg = installSuccessMessage();
    expect(msg).toMatch(
      /theme\/style\/variation\/shade\/endcaps\/wrap\/padding controls/i,
    );
    expect(msg).toContain(DOOR_GLYPH);
  });
});

describe("resolveRenderEntry", () => {
  test("resolves the native binary from node_modules beside the dist", () => {
    // The platform package is staged here, not read from the checkout: the
    // repository's package.json names no platform package, because publishing
    // writes those optionalDependencies (scripts/publish.mjs).
    const dir = mkTmpDir("cpwl-entry-test-");
    fs.mkdirSync(path.join(dir, "dist"));
    const platform = `${process.platform}-${process.arch}`;
    const pkgName = PLATFORM_PACKAGES[platform];
    if (pkgName === undefined) throw new Error(`no package for ${platform}`);
    const pkgDir = path.join(dir, "node_modules", ...pkgName.split("/"));
    fs.mkdirSync(path.join(pkgDir, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: pkgName }),
    );
    fs.writeFileSync(path.join(pkgDir, "bin", "cc-candybar"), "");
    const entry = resolveRenderEntry(
      path.join(dir, "dist", "index.mjs"),
      process.platform,
    );
    expect(entry).toEqual({
      kind: "native",
      sourcePath: fs.realpathSync(path.join(pkgDir, "bin", "cc-candybar")),
    });
  });

  test("falls back to the sibling node shim when no platform package resolves", () => {
    const dir = mkTmpDir("cpwl-entry-test-");
    fs.mkdirSync(path.join(dir, "dist"));
    const entry = resolveRenderEntry(
      path.join(dir, "dist", "index.mjs"),
      process.platform,
    );
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
