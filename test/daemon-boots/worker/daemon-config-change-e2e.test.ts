// [LAW:verifiable-goals] A click's config write is a change the daemon's
// host performs once the click's turn answers. Driven through a daemon as a
// client drives it: clicks sent together each land on the file the one before
// left, so no step is lost, and a hand edit under a step is refused by name
// when ↶ would overwrite it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";

import { linksOf } from "../../../src/click/read";
import {
  clickAnswer,
  render,
  saidOf,
  toldOf,
} from "../../helpers/daemon-e2e";
import { startDaemon } from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

const SID = "change-e2e-session";

// A stepper that writes `globals.padding` into the file on every click, and
// the ↶ that steps the session's history back.
const CONFIG = `// the user's own words
{
  globals: { padding: 1 },
  actions: {
    padUp: { persist: "padding", min: 0, max: 40, by: 1 },
    back: { undo: true },
  },
  segments: {
    pad: { template: '{{ action "padUp" "▶" }} {{ action "back" "↶" }}' },
  },
  root: { h: ["pad"] },
}
`;

function setup() {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv("cc-candybar-change-e2e");
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-change-e2e-project-"));
  const file = path.join(env.XDG_CONFIG_HOME!, "cc-candybar", "config.json5");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, CONFIG);
  const daemon = startDaemon(env);
  const padding = (): number =>
    (JSON5.parse(readFileSync(file, "utf8")) as { globals: { padding: number } })
      .globals.padding;
  const link = async (text: string): Promise<string> => {
    const found = linksOf(await render(daemon, SID, projectDir)).find((l) => l.text === text);
    if (found === undefined) throw new Error(`the bar draws no "${text}" link`);
    return found.url;
  };
  return {
    daemon,
    file,
    padding,
    link,
    dispose: async () => {
      await daemon.stop();
      removeTmpDirs();
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

test("clicks sent together each step the file the click before left, and none is lost", async () => {
  const t = setup();
  try {
    const up = await t.link("▶");
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => clickAnswer(t.daemon, up)),
    );
    // A click answered TIMEOUT while it still waited for its turn is dropped
    // unrun, so what the file must show is one step per click that landed.
    const landed = answers.filter((a) => toldOf(a) === "ok").length;
    expect(landed).toBeGreaterThan(0);
    expect(t.padding()).toBe(1 + landed);
    expect(readFileSync(t.file, "utf8")).toContain("// the user's own words");
  } finally {
    await t.dispose();
  }
});

test("↶ over a setting changed by hand since is refused, naming the setting, and the file keeps the hand edit", async () => {
  const t = setup();
  try {
    const answer = await clickAnswer(t.daemon, await t.link("▶"));
    expect(saidOf(answer)).toBe("ok");
    expect(t.padding()).toBe(2);
    writeFileSync(t.file, readFileSync(t.file, "utf8").replace("padding: 2", "padding: 30"));
    const undone = await clickAnswer(t.daemon, await t.link("↶"));
    expect(toldOf(undone)).toBe("BAD_REQUEST");
    expect(saidOf(undone)).toContain("globals.padding");
    expect(t.padding()).toBe(30);
  } finally {
    await t.dispose();
  }
});
