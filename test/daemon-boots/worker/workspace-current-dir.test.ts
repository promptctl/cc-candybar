import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeAnsi } from "@promptctl/rich-js";
import { PROTOCOL_VERSION } from "../../../src/daemon/foundations/protocol";
import { textOf } from "../../../src/render/frame";
import { frameRequest, hookData, renderBody } from "../../helpers/daemon-e2e";
import { sendDaemonRequest } from "../../../scripts/lib/daemon/wire";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";

// [LAW:behavior-not-structure] The client, hook and reported workspace name
// distinct directories so a fallback can be checked against the actual bar.
test("render ingress checks the workspace current directory before observing it", async () => {
  const isolated = prepareIsolatedDaemonEnv("ccb-workspace");
  const project = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), "ccb-workspace-")),
  );
  let daemon: InWorkerDaemon | undefined;
  try {
    const cwd = path.join(project, "client");
    const workspace = path.join(project, "observed");
    for (const dir of [path.join(project, ".git"), cwd, workspace])
      mkdirSync(dir);
    const config = path.join(project, "bar.json5");
    writeFileSync(
      config,
      JSON.stringify({
        segments: {
          cwd: {
            template:
              "{{ .current_dir }}{{ if .location.main }} at {{ .location.subpath }}{{ else }} unobserved{{ end }}",
          },
        },
        root: { h: ["cwd"] },
      }),
    );
    daemon = startDaemon(isolated.env);
    await daemon.listen(isolated.sockPath);
    const request = (session: string, current?: string) => ({
      ...renderBody(session, cwd, { termCols: 300 }, [
        "cc-candybar",
        "--config-only",
        config,
      ]),
      env: {},
      hookData: {
        ...hookData(session, project),
        workspace: {
          project_dir: project,
          ...(current === undefined ? {} : { current_dir: current }),
        },
      },
    });
    const draw = async (session: string, current?: string) =>
      textOf(await frameRequest(isolated.sockPath, request(session, current)));
    expect(await draw("absolute-workspace", workspace)).toContain(
      `${workspace} at /observed`,
    );

    const relative = await sendDaemonRequest(isolated.sockPath, {
      v: PROTOCOL_VERSION,
      kind: "render",
      ...request("relative-workspace", "./observed"),
    });
    if (relative.ok && "output" in relative)
      throw new Error(
        `rendered a relative workspace: ${decodeAnsi(relative.output).plain}`,
      );
    expect(relative).toMatchObject({
      ok: false,
      code: "BAD_REQUEST",
      error: expect.stringContaining(
        `field 'workspace.current_dir' is not an absolute path: "./observed"`,
      ),
    });
    expect(await draw("unspecified-workspace")).toContain(`${cwd} at /client`);
  } finally {
    await daemon?.stop();
    rmSync(project, { recursive: true, force: true });
    isolated.removeTmpDirs();
  }
});
