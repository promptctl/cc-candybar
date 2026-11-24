import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostOf, worldOf } from "./helpers/host";
import { runRecordHostBundle } from "../src/install";
import {
  readHostBundle,
  recordHostBundle,
  watchedFiles,
  whyUnusable,
  type UnusableRecord,
} from "../src/daemon/host-bundle";
import { hostBundlePath } from "../src/daemon/paths";
import {
  bundleNamedByStatusLine,
  recordIfInstall,
  recordStagedBundle,
} from "../src/install/record";
import { firstShellWord, shellWord } from "../src/shell-word";
import { planAfterKick } from "../src/outcome-plan";
import { formatHostBundleGlyph } from "../src/render/error-glyph";
import { ABSENT, failed } from "../src/utils/outcome";

// The record is the one answer to "which code starts a cold host": written by
// the install's recorder, read by a client that found no host.

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function stateRoot() {
  // The real path, as Node reports a running bundle: the OS temp dir is itself
  // a symlink on macOS.
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "host-bundle-")),
  );
  roots.push(root);
  return { root, host: hostOf({ ...process.env, XDG_STATE_HOME: root }) };
}

function bundleIn(root: string, name: string): string {
  const dist = path.join(root, name, "dist");
  fs.mkdirSync(dist, { recursive: true });
  const bundle = path.join(dist, "index.mjs");
  fs.writeFileSync(bundle, "");
  return bundle;
}

describe("the record a client reads", () => {
  test("a recorded bundle that exists is the bundle", () => {
    const { root, host } = stateRoot();
    const bundle = bundleIn(root, "install");
    recordHostBundle(host, bundle);
    expect(readHostBundle(host)).toEqual({ kind: "ok", value: bundle });
  });

  test("no record is absent, which says to run the install", () => {
    const { host } = stateRoot();
    const record = readHostBundle(host);
    expect(record).toEqual(ABSENT);
    expect(record.kind === "absent" && whyUnusable(record)).toMatch(
      /cc-candybar install/,
    );
  });

  test("a record naming a bundle that is gone fails, naming both", () => {
    const { root, host } = stateRoot();
    const bundle = bundleIn(root, "install");
    recordHostBundle(host, bundle);
    fs.rmSync(bundle);
    const record = readHostBundle(host);
    expect(record.kind).toBe("failed");
    expect(record.kind === "failed" && record.reason).toContain(bundle);
    expect(record.kind === "failed" && record.reason).toContain(
      hostBundlePath(host),
    );
  });

  test("a record that is not an absolute path fails to parse", () => {
    const { host } = stateRoot();
    fs.mkdirSync(path.dirname(hostBundlePath(host)), { recursive: true });
    fs.writeFileSync(hostBundlePath(host), "dist/index.mjs\n");
    expect(readHostBundle(host)).toMatchObject({
      kind: "failed",
      failedAt: "parse",
    });
  });

  test("the writer refuses a relative path", () => {
    const { host } = stateRoot();
    expect(() => recordHostBundle(host, "dist/index.mjs")).toThrow(/absolute/);
    expect(fs.existsSync(hostBundlePath(host))).toBe(false);
  });
});

describe("the files whose change ends a host", () => {
  test("the record is watched beside the bundle and the entry it started through", () => {
    const { host } = stateRoot();
    expect(watchedFiles(host, "/b/index.mjs", "/shim/cc-candybar")).toEqual([
      "/b/index.mjs",
      "/shim/cc-candybar",
      hostBundlePath(host),
    ]);
  });

  test("a bundle run directly is one target, not two", () => {
    const { host } = stateRoot();
    expect(watchedFiles(host, "/b/index.mjs", "/b/index.mjs")).toEqual([
      "/b/index.mjs",
      hostBundlePath(host),
    ]);
    expect(watchedFiles(host, "/b/index.mjs", undefined)).toEqual([
      "/b/index.mjs",
      hostBundlePath(host),
    ]);
  });
});

describe("the statusline decides which bundle is recorded", () => {
  test("an entry names its bundle by adjacency", () => {
    expect(
      bundleNamedByStatusLine({
        type: "command",
        command: "/opt/cc/bin/cc-candybar --config x",
      }),
    ).toBe("/opt/cc/dist/index.mjs");
  });

  test("a quoted entry with a space names its bundle too", () => {
    const entry =
      "/Users/x/Library/Application Support/CCCandybar/bin/cc-candybar";
    expect(bundleNamedByStatusLine({ command: shellWord(entry) })).toBe(
      "/Users/x/Library/Application Support/CCCandybar/dist/index.mjs",
    );
  });

  test.each([
    ["unset", undefined],
    ["not an object", "cc-candybar"],
    ["a command with no command", {}],
    ["the legacy pnpm form", { command: "pnpm dlx @promptctl/cc-candybar@1" }],
    ["a double-quoted word", { command: '"/opt/cc/bin/cc-candybar"' }],
  ])("%s names no bundle", (_name, statusLine) => {
    expect(bundleNamedByStatusLine(statusLine)).toBeNull();
  });

  test("the bundle the statusline names is recorded", () => {
    const { root, host } = stateRoot();
    const bundle = bundleIn(root, "install");
    const entry = path.join(root, "install", "bin", "cc-candybar");
    expect(recordIfInstall(bundle, { command: entry }, host)).toEqual({
      kind: "recorded",
      bundle,
    });
    expect(readHostBundle(host)).toEqual({ kind: "ok", value: bundle });
  });

  test("the install records the bundle it staged, whatever the command's words say", () => {
    const { root, host } = stateRoot();
    const staged = bundleIn(root, "staged");
    expect(recordStagedBundle(staged, host)).toEqual({
      kind: "recorded",
      bundle: staged,
    });
    expect(readHostBundle(host)).toEqual({ kind: "ok", value: staged });
  });

  test("a checkout reached through a symlink is the bundle the statusline names", () => {
    const { root, host } = stateRoot();
    const real = bundleIn(root, "real");
    fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
    const entry = path.join(root, "link", "bin", "cc-candybar");
    expect(bundleNamedByStatusLine({ command: entry })).toBe(
      fs.realpathSync(real),
    );
    expect(
      recordIfInstall(fs.realpathSync(real), { command: entry }, host).kind,
    ).toBe("recorded");
  });

  test("a worktree's bundle, which the statusline does not name, records nothing and leaves the install's record", () => {
    const { root, host } = stateRoot();
    const installed = bundleIn(root, "install");
    const worktree = bundleIn(root, "worktree");
    const entry = path.join(root, "install", "bin", "cc-candybar");
    recordIfInstall(installed, { command: entry }, host);

    const outcome = recordIfInstall(worktree, { command: entry }, host);

    expect(outcome).toEqual({ kind: "not-the-install", named: installed });
    expect(readHostBundle(host)).toEqual({ kind: "ok", value: installed });
  });

  test("a checkout nested inside another checkout is told apart by its own bundle", () => {
    const { root, host } = stateRoot();
    const outer = bundleIn(root, "checkout");
    const nested = bundleIn(root, "checkout/.claude/worktrees/w");
    const entry = path.join(
      root,
      "checkout",
      ".claude",
      "worktrees",
      "w",
      "bin",
      "cc-candybar",
    );
    expect(recordIfInstall(outer, { command: entry }, host).kind).toBe(
      "not-the-install",
    );
    expect(recordIfInstall(nested, { command: entry }, host).kind).toBe(
      "recorded",
    );
  });
});

describe("the recorder reads the user's statusline setting", () => {
  // A user whose Claude settings run the `checkout` entry, on a state of its own.
  function userRunning(checkout: string) {
    const { root } = stateRoot();
    const config = path.join(root, "claude");
    fs.mkdirSync(config);
    const entry = path.join(root, checkout, "bin", "cc-candybar");
    fs.writeFileSync(
      path.join(config, "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: entry } }),
    );
    return {
      root,
      world: worldOf(
        hostOf({
          ...process.env,
          XDG_STATE_HOME: root,
          CLAUDE_CONFIG_DIR: config,
        }),
      ),
    };
  }

  test("the checkout the statusline names is recorded, a worktree beside it is not", () => {
    const { root, world } = userRunning("checkout");
    const checkout = bundleIn(root, "checkout");
    const worktree = bundleIn(root, "worktree");
    const out = jest.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      runRecordHostBundle(worktree, world);
      expect(readHostBundle(world.host).kind).toBe("absent");

      runRecordHostBundle(checkout, world);
      expect(readHostBundle(world.host)).toEqual({
        kind: "ok",
        value: checkout,
      });

      // A worktree built after the checkout was recorded leaves it recorded.
      runRecordHostBundle(worktree, world);
      expect(readHostBundle(world.host)).toEqual({
        kind: "ok",
        value: checkout,
      });
    } finally {
      out.mockRestore();
    }
  });
});

describe("the first word of a command the quoter wrote", () => {
  test.each([
    "/opt/cc/bin/cc-candybar",
    "/Users/x/Library/Application Support/CCCandybar/bin/cc-candybar",
    "/odd/it's here/bin/cc-candybar",
    "=starts/with/equals",
  ])("round-trips %s", (word) => {
    expect(firstShellWord(`${shellWord(word)} --flag 'other arg'`)).toBe(word);
    expect(firstShellWord(shellWord(word))).toBe(word);
  });

  test.each(['"/a b/c"', "a\\ b", "", "   "])(
    "names no word in %j, which only a shell can read",
    (command) => {
      expect(firstShellWord(command)).toBeNull();
    },
  );
});

describe("what a refused kick shows on the bar", () => {
  const asked = { output: "waiting\n", kick: true, debug: "transient" };

  test("a kick that ran leaves the plan as it was", () => {
    expect(planAfterKick(asked, { kind: "kicked" })).toBe(asked);
    expect(planAfterKick({ ...asked, kick: false }, null).output).toBe(
      "waiting\n",
    );
  });

  const refusals: ReadonlyArray<readonly [UnusableRecord, string]> = [
    [{ kind: "absent" }, "no host bundle recorded — run: cc-candybar install"],
    [
      failed("record names a gone bundle", "read"),
      "recorded host bundle is unusable — run: cc-candybar install",
    ],
  ];
  test.each(refusals)(
    "the refusal replaces the waiting indicator: %#",
    (record, words) => {
      const plan = planAfterKick(asked, { kind: "refused", record });
      expect(plan.output).toBe(formatHostBundleGlyph(record.kind));
      expect(plan.output).toContain(words);
      expect(plan.output).not.toContain("waiting");
      expect(plan.debug).toContain(whyUnusable(record));
      // A refused kick starts nothing, so the plan no longer says it kicks.
      expect(plan.kick).toBe(false);
    },
  );
});
