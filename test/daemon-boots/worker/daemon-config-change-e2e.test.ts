// [LAW:verifiable-goals] A settings click's write is a `change` the host
// performs (spec §7): through a real daemon, clicks sent all at once each land
// on the text the one before left, as one undo step each, and a hand edit to
// the setting a click read makes undo refuse, naming it, with the file kept.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";

import {
  effectsUrl,
  VERB_STEP_CONFIG,
  VERB_UNDO,
} from "../../../src/click/wire";
import {
  click,
  clickAnswer,
  drawnLink,
  render,
  saidOf,
} from "../../helpers/daemon-e2e";
import { startDaemon } from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

const SID = "e2e-change-1";
const CLICKS = 10;

test("ten stepper clicks sent at once land ten steps, and undo refuses a setting edited by hand", async () => {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
    "cc-candybar-change-e2e",
  );
  const projectDir = mkdtempSync(
    path.join(os.tmpdir(), "cc-candybar-change-e2e-project-"),
  );
  const userConfigPath = path.join(
    env.XDG_CONFIG_HOME!,
    "cc-candybar",
    "config.json5",
  );
  mkdirSync(path.dirname(userConfigPath), { recursive: true });
  writeFileSync(
    userConfigPath,
    `// mine
{
  globals: { padding: 1 }, // kept as written
  actions: { paddingUp: { persist: "padding", min: 0, max: 16, by: 1 } },
}
`,
  );
  const padding = (): number =>
    (
      JSON5.parse(readFileSync(userConfigPath, "utf8")) as {
        globals: { padding: number };
      }
    ).globals.padding;
  const daemon = startDaemon(env);
  try {
    await render(daemon, SID, projectDir);
    const step = drawnLink(
      daemon,
      effectsUrl([{ verb: VERB_STEP_CONFIG, args: [SID, "padding", "1"] }]),
    );
    const undo = drawnLink(
      daemon,
      effectsUrl([{ verb: VERB_UNDO, args: [SID] }]),
    );

    await Promise.all(
      Array.from({ length: CLICKS }, () => click(daemon, step)),
    );
    expect(padding()).toBe(1 + CLICKS);
    expect(readFileSync(userConfigPath, "utf8")).toContain(
      "// kept as written",
    );

    await click(daemon, undo);
    expect(padding()).toBe(CLICKS);

    writeFileSync(
      userConfigPath,
      readFileSync(userConfigPath, "utf8").replace(
        `padding: ${CLICKS}`,
        "padding: 5",
      ),
    );
    const before = readFileSync(userConfigPath, "utf8");
    const refused = await clickAnswer(daemon, undo);
    expect(saidOf(refused)).toMatch(
      /globals\.padding changed since it was read: it was 10, and is now 5/,
    );
    expect(readFileSync(userConfigPath, "utf8")).toBe(before);
  } finally {
    await daemon.stop();
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  }
});
