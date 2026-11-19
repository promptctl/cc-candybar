import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { linksOf } from "../../../src/click/read";
import { writeConfigFile } from "../../../src/daemon/file-rewrites";
import { textOf } from "../../../src/render/frame";
import {
  frameRequest,
  refusedClick,
  renderBody,
} from "../../helpers/daemon-e2e";
import { readDiagnostics } from "../../helpers/diagnostics-viewer";
import { heldClock } from "../../helpers/held-clock";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { answerRepo } from "../../helpers/repo-approval";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

const USER = `{
  globals: { padding: 1 },
  actions: {
    pad: { persist: 'padding', min: 0, max: 4, by: 1, layer: 'user' },
    interval: { persist: 'menuTimeout', min: 15, max: 60, by: 1, layer: 'project' },
    combined: { do: ['pad', 'interval'] },
  },
  variables: { undoDepth: { kind: 'input', path: 'history.undo', type: 'number' } },
  segments: {
    saved: { template: 'padding={{ .padding.effective }} undo={{ .undoDepth }}' },
    write: { template: '{{ action "combined" "WRITE BOTH" }}' },
  },
  root: { h: ['saved', 'write'] },
}`;
const PROJECT = `{ globals: { menuTimeout: 30 } }\n`;

// [LAW:effects-at-boundaries] Refuse precisely one atomic file publication
// at the adapter, while leaving the real target readable after it fails.
function unwritable(file: string, text: string | null): void {
  if (process.getuid?.() === 0)
    throw new Error(`${file}: config publication forbidden by the fixture`);
  const parent = path.dirname(file);
  const mode = fs.statSync(parent).mode & 0o777;
  fs.chmodSync(parent, 0o500);
  try {
    writeConfigFile(file, text);
  } finally {
    fs.chmodSync(parent, mode);
  }
}

// [LAW:behavior-not-structure] The signed compound click drives production
// planning, publishing, and shared config delivery. The held clock rules out
// a later poll updating either renderer during these assertions.
test.each(["restored", "unrestored"] as const)(
  "both renderers follow disk after a failed compound write is %s",
  async (restore) => {
    const { env, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-rollback");
    const project = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "ccb-rollback-repo-")),
    );
    const userFile = path.join(
      env.XDG_CONFIG_HOME!,
      "cc-candybar",
      "config.json5",
    );
    const projectFile = path.join(project, ".cc-candybar.json5");
    const bundle = path.join(project, "worktree.mjs");
    let daemon: InWorkerDaemon | undefined;
    try {
      fs.mkdirSync(path.dirname(userFile), { recursive: true });
      fs.writeFileSync(userFile, USER);
      fs.writeFileSync(projectFile, PROJECT);
      fs.writeFileSync(bundle, "// in-process renderer entry");
      answerRepo(project, "approved", env);
      const writes: string[] = [];
      const clock = heldClock(new Date());
      const running = startDaemon(env, {
        clock,
        writeConfigFile(file, text) {
          writes.push(file);
          if (
            file === projectFile ||
            (file === userFile && text === USER && restore === "unrestored")
          ) {
            unwritable(file, text);
            return;
          }
          writeConfigFile(file, text);
        },
      });
      daemon = running;
      const draw = (alternate = false) =>
        frameRequest(running, {
          ...renderBody(alternate ? "observer" : "writer", project, {
            termCols: 300,
          }),
          env: alternate ? { CC_CANDYBAR_NAME: "worktree" } : {},
          ...(alternate && { client: { kind: "node", bundle, source: null } }),
        });
      const before = await draw();
      if (!textOf(before).includes("padding=1 undo=0")) {
        const warnings = await readDiagnostics(
          running,
          "writer",
          project,
          before,
        );
        throw new Error(
          `initial frame ${textOf(before)}: ${JSON.stringify(warnings.map(({ text }) => text))}`,
        );
      }
      expect(textOf(await draw(true))).toContain("padding=1 undo=0");
      const commit = linksOf(before).find(({ text }) => text === "WRITE BOTH");
      if (commit === undefined)
        throw new Error(`missing compound link in ${textOf(before)}`);
      await refusedClick(running, commit.url, "threw");
      expect(writes).toEqual([userFile, projectFile, userFile]);
      expect(fs.readFileSync(projectFile, "utf8")).toBe(PROJECT);
      const disk = fs.readFileSync(userFile, "utf8");
      if (restore === "restored") expect(disk).toBe(USER);
      else expect(disk).toContain("padding: 2");

      const padding = restore === "restored" ? 1 : 2;
      const [writer, observer] = await Promise.all([draw(), draw(true)]);
      expect(textOf(writer)).toContain(`padding=${padding} undo=0`);
      expect(textOf(observer)).toContain(`padding=${padding} undo=0`);
      const messages = (
        await readDiagnostics(running, "writer", project, writer)
      )
        .map(({ text }) => text)
        .join("\n");
      expect(messages).toContain(projectFile);
      if (restore === "unrestored") expect(messages).toContain(userFile);
    } finally {
      await daemon?.stop();
      removeTmpDirs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  },
);
