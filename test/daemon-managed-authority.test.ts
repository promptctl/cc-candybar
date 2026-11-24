import fs from "node:fs";
import path from "node:path";
import { inProcessRenderer } from "../src/in-process-renderer";
import type { RendererPort } from "../src/daemon/renderer-process";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { render } from "./helpers/daemon-e2e";
import { startDaemon } from "./helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "./helpers/spawn-isolated-daemon";

test("a renderer's unmanaged claims cannot make folders or read session files", async () => {
  const { env, stateDir, removeTmpDirs } =
    prepareIsolatedDaemonEnv("ccb-files");
  const session = sessionIdOf("folder-claim");
  const unsolicited = path.join(stateDir, "never-make");
  const readOnlyClaim = path.join(stateDir, "never-read");
  const file = path.join(readOnlyClaim, `${session}.json`);
  fs.mkdirSync(readOnlyClaim);
  fs.writeFileSync(file, '"unsolicited file"');
  const realRenderer = inProcessRenderer();
  const renderer: RendererPort = (prepared) => ({
    start(own) {
      const link = realRenderer(prepared).start(own);
      return {
        ...link,
        renderer: {
          answer: async (input) => {
            const output = await link.renderer.answer(input);
            if (input.event.kind === "close-journal" || input.event.kind === "close-views") return output;
            return {
              ...output,
              subscriptions: {
                ...output.subscriptions,
                managedFolders: [unsolicited],
                sources: {
                  [session]: [
                    {
                      kind: "plugin",
                      source: "unmanaged",
                      folder: readOnlyClaim,
                    },
                  ],
                },
              },
            };
          },
        },
      };
    },
  });
  const daemon = startDaemon(env, { renderer });
  try {
    await render(daemon, session, stateDir);
    await daemon.stop();
    const log = fs.readFileSync(daemon.log, "utf8");
    expect({
      created: fs.existsSync(unsolicited),
      read: log
        .split("\n")
        .some(
          (line) =>
            line.includes("plugin storage refresh") && line.includes(file),
        ),
    }).toEqual({ created: false, read: false });
  } finally {
    await daemon.stop();
    removeTmpDirs();
  }
});
