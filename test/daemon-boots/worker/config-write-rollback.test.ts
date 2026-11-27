import { reportingClock } from "../../../src/daemon/task-throws";
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
import { logLines } from "../../../scripts/lib/daemon/log";
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
    open: { set: 'nav.menu', to: 'open' },
    combined: { do: ['open', 'pad', 'interval'] },
  },
  variables: { undoDepth: { kind: 'input', path: 'history.undo', type: 'number' }, backDepth: {kind:'input',path:'navigation.back',type:'number'}, menu:{kind:'state',key:'nav.menu',default:'closed'} },
  segments: {
    saved: { template: 'padding={{ .padding.effective }} undo={{ .undoDepth }} back={{ .backDepth }} menu={{ .menu }}' },
    write: { template: '{{ action "combined" "WRITE BOTH" }}' },
  },
  root: { h: ['saved', 'write'] },
}`;
const PROJECT = `{ globals: { menuTimeout: 30 } }\n`;

// [LAW:effects-at-boundaries] Refuse precisely one atomic file publication
// at the adapter, while leaving the real target readable after it fails.
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
      fs.realpathSync.native(env.XDG_CONFIG_HOME!),
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
      const clock = heldClock(new Date(), reportingClock);
      const running = startDaemon(env, {
        clock,
        writeConfigFile(file, text) {
          writes.push(file);
          if (
            file === projectFile ||
            (file === userFile && text === USER && restore === "unrestored")
          ) {
            throw new Error(`${file}: config publication forbidden by the fixture`);
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
      expect(textOf(writer)).toContain(
        `padding=${padding} undo=0 back=0 menu=closed`,
      );
      expect(textOf(observer)).toContain(
        `padding=${padding} undo=0 back=0 menu=closed`,
      );
      const messages = (
        await readDiagnostics(running, "writer", project, writer)
      )
        .map(({ text }) => text)
        .join("\n");
      expect(messages).toContain(projectFile);
      if (restore === "unrestored") expect(messages).toContain(userFile);

      // The shared origin is observed just once for both holders. Read the
      // drained log so the complete-rollback case also checks for extra work.
      await running.stop();
      daemon = undefined;
      const landings = logLines(env).filter((line) =>
        line.includes("config discovery why=landed"),
      );
      expect(landings).toEqual(
        restore === "unrestored"
          ? [expect.stringContaining("followed=1 discovered=1 moved=1")]
          : [],
      );
    } finally {
      await daemon?.stop();
      removeTmpDirs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  },
);
