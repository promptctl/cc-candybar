import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN = path.join(__dirname, "..", "plugin");
const FILE = "the written config.json5";
const CONTENT = '{ root: { h: [{ text: "WRITTEN CONFIG" }] } }';

// [LAW:verifiable-goals] A fake executable records the preview's real argv at
// the client boundary. It returns the selected file so a draw of a generated
// template cannot satisfy the written-file case.
function withPreview(
  inspect: (
    run: (args: readonly string[]) => ReturnType<typeof captured>,
  ) => void,
  cold = false,
): void {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-preview-")),
  );
  try {
    const bin = path.join(root, "bin");
    const plugin = path.join(root, "plugin");
    for (const dir of [
      bin,
      path.join(plugin, "bin"),
      path.join(plugin, "templates"),
    ])
      fs.mkdirSync(dir, { recursive: true });
    const script = path.join(plugin, "bin", "preview.sh");
    fs.copyFileSync(path.join(PLUGIN, "bin", "preview.sh"), script);
    fs.copyFileSync(
      path.join(PLUGIN, "templates", "config.json"),
      path.join(plugin, "templates", "config.json"),
    );
    fs.writeFileSync(path.join(root, FILE), CONTENT);
    fs.writeFileSync(
      path.join(bin, "cc-candybar"),
      `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "$PREVIEW_CALLS"
[[ $# == 1 && $1 == --config-only=* ]] || exit 7
cat >> "$PREVIEW_CALLS.payloads"
if [[ $PREVIEW_COLD == true && ! -f $PREVIEW_CALLS.warm ]]; then
    touch "$PREVIEW_CALLS.warm"
    exit 0
fi
cat "\${1#*=}"
`,
      { mode: 0o700 },
    );
    inspect((args) => captured(root, bin, script, args, cold));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function captured(
  root: string,
  bin: string,
  script: string,
  args: readonly string[],
  cold: boolean,
) {
  const calls = path.join(root, "calls");
  const result = spawnSync("bash", [script, ...args], {
    cwd: root,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: root,
      PREVIEW_CALLS: calls,
      PREVIEW_COLD: String(cold),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: fs.existsSync(calls)
      ? fs.readFileSync(calls, "utf8").trim().split("\n")
      : [],
    payloads: fs.existsSync(`${calls}.payloads`)
      ? fs
          .readFileSync(`${calls}.payloads`, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [],
    written: path.join(root, FILE),
  };
}

test.each([FILE, `~/${FILE}`])(
  "the written file %s is sent once in isolated mode",
  (file) => {
    withPreview((run) => {
      const result = run([`--config-only=${file}`]);
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([`--config-only=${result.written}`]);
      expect(result.stdout.trim()).toBe(CONTENT);
    });
  },
);

test("a cold retry shares its payload and each compared config gets its own session", () => {
  withPreview((run) => {
    const result = run(["--compare-presets"]);
    expect(result.status).toBe(0);
    const [cold, first, ...rest] = result.payloads;
    expect(cold).toEqual(first);
    expect(result.calls[0]).toBe(result.calls[1]);
    expect(first).toMatchObject({
      hook_event_name: "Status",
      session_id: expect.any(String),
    });
    expect(rest.length).toBeGreaterThan(0);
    const distinctConfigs = new Set(result.calls);
    const sessions = [first, ...rest].map((payload) => payload.session_id);
    expect(new Set(sessions).size).toBe(distinctConfigs.size);
    expect(sessions).toHaveLength(distinctConfigs.size);
  }, true);
});

test("template choices are substituted and sent once in isolated mode", () => {
  withPreview((run) => {
    const result = run(["--theme=nord", "--endcaps=metro", "--preset=git"]);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      expect.stringMatching(
        /^--config-only=\/.*\/config-nord-metro-git\.json$/,
      ),
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      globals: { palette: "nord", endcaps: "metro", preset: "git" },
    });
  });
});

test.each([
  { args: ["--theme=dark"], message: "unknown theme choice" },
  { args: ["--endcaps="], message: "unknown endcaps choice" },
  { args: ["--preset=defaul"], message: "unknown preset choice" },
  { args: ["--config-only="], message: "--config-only needs a path" },
  { args: ["--config-only=missing.json5"], message: "cannot read config file" },
  {
    args: [`--config-only=${FILE}`, "--compare-presets"],
    message: "cannot be combined",
  },
  { args: ["--unknown"], message: "unknown option" },
])(
  "rejects $args before calling the statusline client",
  ({ args, message }) => {
    withPreview((run) => {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(message);
      expect(result.calls).toEqual([]);
    });
  },
);
