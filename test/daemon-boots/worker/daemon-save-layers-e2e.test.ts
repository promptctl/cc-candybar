// [LAW:verifiable-goals] candybar-host-renderer-x96a.u2t's done-when: in a
// project whose repository is approved, a setting saved to user, project and
// local in turn lands in each one's file, the bar draws the winning value after
// each, and git sees nothing of the local file. And which layer a click writes
// is the config's to say: a save that writes the user layer beside a stepper
// that writes the project's needs no code. Every click is a link the bar drew,
// found by its text and sent over the wire.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import JSON5 from "json5";
import os from "node:os";
import path from "node:path";

import { linksOf } from "../../../src/click/read";
import { DOOR_GLYPH } from "../../../src/config/disclosure";
import {
  openFrameStream,
  type StreamEnd,
} from "../../../src/daemon/client-frames";
import { textOf } from "../../../src/render/frame";
import { HANDOFF_BUTTON } from "../../../src/renderer/lane-handoff";
import { listResolvablePaletteNames } from "../../../src/themes/policy";
import { click, linkTo, render, renderUntil } from "../../helpers/daemon-e2e";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { answerRepo } from "../../helpers/repo-approval";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { until } from "../../helpers/until";

jest.setTimeout(60_000);

const [A, B, C] = listResolvablePaletteNames().filter((t) => t !== "dusk");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  });

interface Case {
  readonly daemon: InWorkerDaemon;
  readonly sockPath: string;
  readonly project: string;
  readonly userFile: string;
  readonly projectFile: string;
  readonly localFile: string;
}

// A daemon over an approved repository, the user's config `config`.
async function withProject(
  config: string,
  body: (c: Case) => Promise<void>,
): Promise<void> {
  const { env, sockPath, removeTmpDirs } =
    prepareIsolatedDaemonEnv("ccb-layers");
  const project = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-layers-repo-")),
  );
  git(project, "init", "-q");
  git(project, "commit", "-q", "--allow-empty", "-m", "root");
  answerRepo(project, "approved", env);
  const userFile = path.join(
    env.XDG_CONFIG_HOME!,
    "cc-candybar",
    "config.json5",
  );
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, config);
  const daemon = startDaemon(env);
  try {
    await body({
      daemon,
      sockPath,
      project,
      userFile,
      projectFile: path.join(project, ".cc-candybar.json5"),
      localFile: path.join(project, ".cc-candybar.local.json5"),
    });
  } finally {
    await daemon.stop();
    removeTmpDirs();
    fs.rmSync(project, { recursive: true, force: true });
  }
}

// The globals a layer's file sets; none for a file that does not exist.
const globalsOf = (file: string): Record<string, unknown> =>
  fs.existsSync(file)
    ? ((
        JSON5.parse(fs.readFileSync(file, "utf8")) as {
          globals?: Record<string, unknown>;
        }
      ).globals ?? {})
    : {};

const SID = "save-layers";

async function draftWrap(
  daemon: InWorkerDaemon,
  project: string,
): Promise<void> {
  const draw = () => render(daemon, SID, project);
  await click(daemon, linkTo(await draw(), DOOR_GLYPH));
  await click(daemon, linkTo(await draw(), "⚙ config"));
  await click(daemon, linkTo(await draw(), "☑ wrap"));
}

// The bar draws the theme it renders, a link to pick each theme, and a save
// link per layer the session can write.
const ASKING = `{
  actions: {
    pickA: { set: "theme", to: "${A}" },
    pickB: { set: "theme", to: "${B}" },
    pickC: { set: "theme", to: "${C}" },
    keep: { save: true, layer: "ask" },
  },
  variables: {
    project: { kind: "input", path: "layers.project", type: "boolean", default: false },
    local: { kind: "input", path: "layers.local", type: "boolean", default: false },
  },
  segments: {
    shown: { template: 'THEME={{ .theme.effective }}' },
    picks: { template: '{{ action "pickA" "A" }} {{ action "pickB" "B" }} {{ action "pickC" "C" }}' },
    saves: {
      template: '{{ action "keep" "U" "user" }}{{ if .project }} {{ action "keep" "P" "project" }}{{ end }}{{ if .local }} {{ action "keep" "L" "local" }}{{ end }}',
    },
  },
  root: { h: ["shown", "picks", "saves"] },
}
`;

describe("save writes the layer it is asked for", () => {
  test("settings offers no save or durable reset when the config has no writable layer", async () => {
    await withProject(ASKING, async ({ daemon, project, userFile }) => {
      fs.rmSync(userFile);
      fs.mkdirSync(userFile);
      await draftWrap(daemon, project);

      const drafted = await render(daemon, SID, project);
      expect(textOf(drafted)).toContain("☐ wrap");
      const labels = linksOf(drafted).map(({ text }) => text);
      for (const label of ["💾 save 1", "↺", "⟲"]) {
        expect(labels).not.toContain(label);
      }
      expect(fs.statSync(userFile).isDirectory()).toBe(true);
    });
  });

  test("a failed reload keeps the draft but withdraws save until a layer loads", async () => {
    await withProject(ASKING, async ({ daemon, project, userFile }) => {
      await draftWrap(daemon, project);
      expect(textOf(await render(daemon, SID, project))).toContain("💾 save 1");
      fs.rmSync(userFile);
      fs.mkdirSync(userFile);
      const retained = await renderUntil(
        daemon,
        SID,
        project,
        (frame) => textOf(frame).includes("⚠"),
        "a config load failure over the current draft",
      );
      expect(textOf(retained)).toContain("☐ wrap");
      expect(textOf(retained)).not.toContain("💾 save 1");
      fs.rmSync(userFile, { recursive: true });
      fs.writeFileSync(userFile, ASKING);
      await renderUntil(
        daemon,
        SID,
        project,
        (frame) => textOf(frame).includes("💾 save 1"),
        "save to return with the readable file",
      );
    });
  });

  test("edit mode offers one transaction Save in an approved project", async () => {
    await withProject(
      ASKING,
      async ({ daemon, project, userFile, projectFile }) => {
        const draw = () => render(daemon, SID, project);
        await click(daemon, linkTo(await draw(), DOOR_GLYPH));
        await click(daemon, linkTo(await draw(), "✎ arrange"));
        await click(daemon, linkTo(await draw(), "⚙ config"));
        await click(daemon, linkTo(await draw(), "☑ wrap"));

        const frame = await draw();
        expect(
          linksOf(frame).filter(({ text }) => text === "✓ save"),
        ).toHaveLength(1);
        fs.rmSync(userFile);
        fs.mkdirSync(userFile);
        const preserved = await renderUntil(
          daemon,
          SID,
          project,
          (f) => !linksOf(f).some(({ text }) => text === "✓ save"),
          "the edit preview without Save while its destination is unreadable",
        );
        expect(textOf(preserved)).toContain("☐ wrap");
        expect(textOf(preserved)).toContain("↩ cancel");
        expect(textOf(preserved)).toContain("⚠");
        fs.rmSync(userFile, { recursive: true });
        fs.writeFileSync(userFile, ASKING);
        const ready = await renderUntil(
          daemon,
          SID,
          project,
          (f) => linksOf(f).some(({ text }) => text === "✓ save"),
          "the edit preview with Save after its destination returns",
        );
        await click(daemon, linkTo(ready, "✓ save"));
        expect(globalsOf(userFile)).toMatchObject({ autoWrap: false });
        expect(fs.existsSync(projectFile)).toBe(false);
      },
    );
  });

  test("the pane handoff explains when the pane stays enabled by project config", async () => {
    await withProject(
      ASKING,
      async ({ daemon, project, projectFile, sockPath }) => {
        const checkedIn = "{ globals: { experimentalPane: true } }";
        fs.writeFileSync(projectFile, checkedIn);
        git(project, "add", ".cc-candybar.json5");
        git(project, "commit", "-q", "-m", "enable the pane");
        await daemon.listen(sockPath);
        await render(daemon, SID, project);

        let sent = false;
        let ended: StreamEnd | null = null;
        const feed = openFrameStream(
          sockPath,
          SID,
          "pane",
          () => {
            sent = true;
          },
          (end) => {
            ended = end;
          },
        );
        try {
          await until(() => {
            if (ended !== null)
              throw new Error(
                `the pane stream ended: ${JSON.stringify(ended)}`,
              );
            return sent;
          }, "the project-enabled pane frame");
          const frame = await render(daemon, SID, project);
          expect(textOf(frame)).toContain(
            "The pane stays enabled by its config",
          );
          expect(linksOf(frame).map(({ text }) => text)).not.toContain(
            HANDOFF_BUTTON,
          );
          expect(fs.readFileSync(projectFile, "utf8")).toBe(checkedIn);
        } finally {
          feed.close();
        }
      },
    );
  });

  test("user, then project, then local: each lands in its own file, the bar draws the winner, and git sees no local file", async () => {
    await withProject(ASKING, async (c) => {
      const { daemon, project } = c;
      let frame = await render(daemon, SID, project);

      const pickAndSave = async (pick: string, save: string, theme: string) => {
        await click(daemon, linkTo(frame, pick));
        frame = await render(daemon, SID, project);
        await click(daemon, linkTo(frame, save));
        frame = await renderUntil(
          daemon,
          SID,
          project,
          (f) => textOf(f).includes(`THEME=${theme}`),
          `the bar drawing ${theme}`,
        );
      };

      await pickAndSave("A", "U", A!);
      expect(globalsOf(c.userFile)).toEqual({ palette: A });
      expect(fs.existsSync(c.projectFile)).toBe(false);

      await pickAndSave("B", "P", B!);
      expect(globalsOf(c.projectFile)).toEqual({ palette: B });
      expect(globalsOf(c.userFile)).toEqual({ palette: A });
      // The project's setting is shared by committing it.
      git(project, "add", ".cc-candybar.json5");
      git(project, "commit", "-q", "-m", "share the theme");

      await pickAndSave("C", "L", C!);
      expect(globalsOf(c.localFile)).toEqual({ palette: C });
      expect(globalsOf(c.projectFile)).toEqual({ palette: B });
      expect(globalsOf(c.userFile)).toEqual({ palette: A });
      expect(git(project, "status", "--porcelain")).toBe("");

      // The winner is the highest layer: without the local file, the
      // project's value is drawn again.
      fs.rmSync(c.localFile);
      await renderUntil(
        daemon,
        SID,
        project,
        (f) => textOf(f).includes(`THEME=${B}`),
        `the bar drawing the project's ${B}`,
      );
    });
  });

  test("a save that writes the user layer beside a stepper that writes the project's needs no code", async () => {
    const config = `{
  actions: {
    pickA: { set: "theme", to: "${A}" },
    keep: { save: true, layer: "user" },
    wider: { persist: "padding", min: 0, max: 4, by: 1, layer: "project" },
  },
  segments: {
    shown: { template: 'THEME={{ .theme.effective }}' },
    controls: { template: '{{ action "pickA" "A" }} {{ action "keep" "SAVE" }} {{ action "wider" "+" }}' },
  },
  root: { h: ["shown", "controls"] },
}
`;
    await withProject(config, async (c) => {
      const { daemon, project } = c;
      let frame = await render(daemon, SID, project);
      await click(daemon, linkTo(frame, "+"));
      expect(globalsOf(c.projectFile)).toEqual({ padding: expect.any(Number) });
      expect(globalsOf(c.userFile)).toEqual({});

      frame = await render(daemon, SID, project);
      await click(daemon, linkTo(frame, "A"));
      frame = await render(daemon, SID, project);
      await click(daemon, linkTo(frame, "SAVE"));
      await renderUntil(
        daemon,
        SID,
        project,
        (f) => textOf(f).includes(`THEME=${A}`),
        `the bar drawing ${A}`,
      );
      expect(globalsOf(c.userFile)).toEqual({ palette: A });
      expect(globalsOf(c.projectFile)).toEqual({ padding: expect.any(Number) });
    });
  });
});
