// [LAW:verifiable-goals] `cc-candybar install` changes the user's files whole
// or not at all: an install that fails at any step leaves every file under
// the home as it found it, and the statusLine command it writes is the
// staged entry alone, by the rule it states. Each install runs in a home of
// its own, its commands through a fake launcher, for darwin as for linux, so
// nothing here touches the machine's own settings or Launch Services.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostOf } from "../scripts/lib/host";
import { install, type InstallWorld } from "../src/install/index";
import { hostBundlePath } from "../src/daemon/paths";
import { readHostBundle } from "../src/daemon/host-bundle";
import { shellWord } from "../src/shell-word";
import type { LaunchOpts, LaunchResult } from "../src/proc/launcher";

let root: string;
let home: string;
let out: string[];
let restore: Array<() => void>;

beforeEach(() => {
  // The real path, as a staged entry's adjacency resolves it: the OS temp
  // dir is itself a symlink on macOS.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "install-")));
  home = path.join(root, "home");
  fs.mkdirSync(home);
  out = [];
  restore = (["stdout", "stderr"] as const).map((stream) => {
    const spy = jest
      .spyOn(process[stream], "write")
      .mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      });
    return () => spy.mockRestore();
  });
});
afterEach(() => {
  for (const r of restore) r();
  fs.rmSync(root, { recursive: true, force: true });
});

// A checkout's build at `version`, laid out as install reads one: the bundle,
// the attach launcher and its preload, the node shim and the built forwarder.
function checkout(version: string): string {
  const dir = path.join(root, `checkout-${version}`);
  const files: Record<string, string> = {
    "dist/index.mjs": `// bundle ${version}\n`,
    "dist/cc-extra/launcher.js": `// launcher ${version}\n`,
    "dist/attach-preload.cjs": `// preload ${version}\n`,
    "bin/cc-candybar": `#!/bin/sh\n# shim ${version}\n`,
    "bin/cc-candybar-url-handler-native": `MACHO ${version}`,
  };
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return path.join(dir, "dist", "index.mjs");
}

// A launcher that records each command and answers as told, by binary name;
// `during` runs inside the named command, as the machine would go on while
// it ran.
function world(
  answers: Partial<Record<string, Partial<LaunchResult>>> = {},
  during: Partial<Record<string, () => void>> = {},
) {
  const ran: string[] = [];
  const launcher: InstallWorld["launcher"] = {
    launchSync: (opts: LaunchOpts): LaunchResult => {
      const bin = path.basename(opts.bin);
      ran.push(bin);
      during[bin]?.();
      return {
        ok: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
        ...answers[bin],
      } as LaunchResult;
    },
  };
  return { ran, world: { host: hostOf({}, { home, tmp: root }), launcher } };
}

const settingsFile = () => path.join(home, ".claude", "settings.json");
const stagedBin = () =>
  path.join(
    home,
    "Library",
    "Application Support",
    "CCCandybar",
    "bin",
    "cc-candybar",
  );
const stagedDist = () =>
  path.join(
    home,
    "Library",
    "Application Support",
    "CCCandybar",
    "dist",
    "index.mjs",
  );
const record = () => hostBundlePath(hostOf({}, { home, tmp: root }));

// Every entry under the home: each directory, each file's bytes and mode, and
// each link's target.
function tree(): Record<string, string> {
  const seen: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const at = path.join(dir, name);
      const key = path.relative(home, at);
      const st = fs.lstatSync(at);
      if (st.isSymbolicLink()) seen[key] = `-> ${fs.readlinkSync(at)}`;
      else if (st.isDirectory()) {
        seen[key] = "dir";
        walk(at);
      } else
        seen[key] =
          `${(st.mode & 0o777).toString(8)} ${fs.readFileSync(at, "utf8")}`;
    }
  };
  walk(home);
  return seen;
}

const writeSettings = (settings: object): void => {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
};
const statusLineCommand = (): unknown =>
  JSON.parse(fs.readFileSync(settingsFile(), "utf8")).statusLine.command;

describe("an install that lands", () => {
  test("stages the runtime and the app, sets the staged entry alone as the statusLine command, and records the bundle", () => {
    const { ran, world: w } = world({
      killall: { ok: false, reason: "non-zero", exitCode: 1 },
    });
    install([], checkout("v1"), w, "darwin");

    expect(statusLineCommand()).toBe(shellWord(stagedBin()));
    expect(fs.readFileSync(stagedDist(), "utf8")).toBe("// bundle v1\n");
    expect(fs.statSync(stagedBin()).mode & 0o777).toBe(0o755);
    expect(readHostBundle(w.host)).toEqual({ kind: "ok", value: stagedDist() });
    expect(ran).toEqual(["codesign", "killall", "lsregister"]);
    expect(out.join("")).toContain(
      `Set the statusLine command in ${settingsFile()}: ${shellWord(stagedBin())}`,
    );
    // No name the install staged or kept aside is left behind.
    expect(Object.keys(tree()).filter((k) => k.endsWith(".tmp"))).toEqual([]);
  });

  test("on a machine with no URL handler, runs no command", () => {
    const { ran, world: w } = world();
    install([], checkout("v1"), w, "linux");
    const staged = path.join(home, ".local", "share", "cc-candybar");
    expect(statusLineCommand()).toBe(
      shellWord(path.join(staged, "bin", "cc-candybar")),
    );
    expect(ran).toEqual([]);
    expect(out.join("")).toContain("Skipping URL handler");
  });

  test("a re-install replaces every staged file, and leaves none of the old ones", () => {
    install([], checkout("v1"), world().world, "darwin");
    const stale = path.join(path.dirname(stagedDist()), "cc-extra", "gone.js");
    fs.writeFileSync(stale, "// from an older release\n");
    install([], checkout("v2"), world().world, "darwin");
    expect(fs.readFileSync(stagedDist(), "utf8")).toBe("// bundle v2\n");
    expect(fs.existsSync(stale)).toBe(false);
    expect(Object.keys(tree()).filter((k) => k.endsWith(".tmp"))).toEqual([]);
  });
});

// The rule install states: the command it writes is the staged entry alone,
// and a command it did not write is the user's.
describe("what install does to a command it did not write", () => {
  test.each([[["--style=minimal"]], [["--force", "--theme=nord"]]])(
    "an argument other than --force (%j) is refused before anything changes",
    (args) => {
      expect(() =>
        install(args, checkout("v1"), world().world, "darwin"),
      ).toThrow(/install takes only --force/);
      expect(tree()).toEqual({});
    },
  );

  test("the staged entry with the user's words after it is kept, and the bundle it runs is recorded", () => {
    const { world: w } = world();
    install([], checkout("v1"), w, "darwin");
    const theirs = `${shellWord(stagedBin())} --config /x.json5`;
    writeSettings({ statusLine: { type: "command", command: theirs } });

    install([], checkout("v2"), w, "darwin");
    expect(statusLineCommand()).toBe(theirs);
    expect(out.join("")).toContain("appears customized");
    expect(readHostBundle(w.host)).toEqual({ kind: "ok", value: stagedDist() });

    install(["--force"], checkout("v2"), w, "darwin");
    expect(statusLineCommand()).toBe(shellWord(stagedBin()));
  });

  test("a command that does not run the staged entry is kept, and no bundle is recorded", () => {
    const { world: w } = world();
    writeSettings({
      statusLine: { type: "command", command: "/usr/bin/other" },
    });
    install([], checkout("v1"), w, "darwin");
    expect(statusLineCommand()).toBe("/usr/bin/other");
    expect(readHostBundle(w.host).kind).toBe("absent");
    expect(out.join("")).toContain("Re-run with --force");
  });

  test("a malformed statusLine refuses the install, naming the file, before anything changes", () => {
    writeSettings({ statusLine: "cc-candybar" });
    const before = tree();
    expect(() =>
      install(["--force"], checkout("v1"), world().world, "darwin"),
    ).toThrow(
      `cannot read ${settingsFile()}: statusLine is "cc-candybar", not an object`,
    );
    expect(tree()).toEqual(before);
  });
});

// [LAW:no-silent-failure] A failed install puts back what it changed. Each
// case starts from a first install, then changes what the next install must
// write over (a legacy command, a record naming other code), so a failure
// after any step has something to put back.
describe("an install that fails", () => {
  function installedThenStale() {
    install([], checkout("v1"), world().world, "darwin");
    writeSettings({
      env: { A: "1" },
      statusLine: {
        type: "command",
        command: "pnpm dlx @promptctl/cc-candybar@1.0.0",
        refreshInterval: 1,
      },
    });
    fs.writeFileSync(record(), "/old/dist/index.mjs\n");
    return tree();
  }

  test("at its last step leaves every file under the home as it was", () => {
    const before = installedThenStale();
    const { ran, world: w } = world({
      lsregister: { ok: false, reason: "non-zero", exitCode: 1 },
    });
    expect(() => install([], checkout("v2"), w, "darwin")).toThrow(
      /lsregister failed[^]*put back every change it made/,
    );
    expect(ran).toEqual(["codesign", "killall", "lsregister"]);
    expect(tree()).toEqual(before);
  });

  test("while signing the app leaves the staged runtime and the app as they were", () => {
    const before = installedThenStale();
    const { world: w } = world({
      codesign: { ok: false, reason: "non-zero", exitCode: 1 },
    });
    expect(() => install([], checkout("v2"), w, "darwin")).toThrow(
      /codesign failed/,
    );
    expect(tree()).toEqual(before);
  });

  test("on a first install leaves no directory it made", () => {
    const { world: w } = world({
      lsregister: { ok: false, reason: "non-zero", exitCode: 1 },
    });
    expect(() => install([], checkout("v1"), w, "darwin")).toThrow(
      /lsregister failed/,
    );
    expect(tree()).toEqual({});
  });

  // The settings file is written while the install runs (Claude Code's own
  // `/autocompact` writes it): the install does not write over it, and puts
  // back everything else.
  test("when the settings file changes under it, keeps that change and puts back the rest", () => {
    const before = installedThenStale();
    const theirs = JSON.stringify({ autoCompactWindow: 200000 });
    const { world: w } = world(
      {},
      { codesign: () => fs.writeFileSync(settingsFile(), theirs) },
    );
    expect(() => install([], checkout("v2"), w, "darwin")).toThrow(
      `${settingsFile()} changed while the install ran, so the install did not write it`,
    );
    expect(tree()).toEqual({
      ...before,
      [path.relative(home, settingsFile())]: `644 ${theirs}`,
    });
  });
});
