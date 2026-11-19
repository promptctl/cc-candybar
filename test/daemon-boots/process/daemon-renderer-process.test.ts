// [LAW:verifiable-goals] On a REAL daemon: the renderer runs in a process of
// its own, a renderer that dies is started again, and the bar the next one
// draws says the restart happened and what it cost.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeAnsi, Style } from "@promptctl/rich-js";

import { textOf } from "../../../src/render/frame";
import { effectsOf, linksOf } from "../../../src/click/read";
import {
  VERB_OPEN_VSCODE,
  VERB_REPO_CONFIG,
  VERB_RUN,
} from "../../../src/click/wire";
import {
  openFrameStream,
  type StreamEnd,
} from "../../../src/daemon/client-frames";
import type { Response } from "../../../src/daemon/foundations/protocol";
import { RENDERER_WIRE_VERSION } from "../../../src/renderer-interface/wire";
import { EMPTY_STORED_STATE } from "../../../src/renderer-interface/stored-state";
import { LINK_KEY_BYTES } from "../../../src/click/link-signer";
import { DISCLOSURE_GLYPH_CLOSE } from "../../../src/config/disclosure";
import {
  click,
  drawnLink,
  findUrl,
  frameRequest,
  hookData,
  render,
  renderBody,
  renderRequest,
  renderUntil,
  runRealClient,
} from "../../helpers/daemon-e2e";
import {
  spawnIsolatedDaemon,
  type IsolatedDaemonHandle,
} from "../../helpers/spawn-isolated-daemon";
import { until } from "../../helpers/until";
import { readDiagnostics } from "../../helpers/diagnostics-viewer";

jest.setTimeout(30_000);

const COMPATIBLE_BOOT = {
  wireVersion: RENDERER_WIRE_VERSION,
  boot: {
    digest: "another-worktree-build",
    stored: EMPTY_STORED_STATE,
    host: { home: "/home", tmp: os.tmpdir(), env: {} },
    memoryLimitBytes: 1,
    linkKey: {
      kind: "ok",
      value: Buffer.alloc(LINK_KEY_BYTES).toString("base64"),
    },
  },
};

function bootChild(...lines: readonly object[]) {
  return runRealClient(
    ["renderer"],
    {
      cwd: process.cwd(),
      env: process.env,
      input: lines
        .map((line) => `${JSON.stringify({ kind: "boot", ...line })}\n`)
        .join(""),
    },
    1,
  );
}

describe("the renderer wire handshake", () => {
  test.each([
    ["no version", {}, "no version"],
    [
      "a different version",
      { wireVersion: RENDERER_WIRE_VERSION + 1 },
      `version ${RENDERER_WIRE_VERSION + 1}`,
    ],
  ])(
    "the built child refuses %s before reading its boot payload",
    (_name, version, sent) => {
      // Only an old digest is present. Building the renderer would fail for a
      // missing key before it could report the actual version mismatch.
      const child = bootChild(
        { ...version, boot: { digest: "old-build" } },
        COMPATIBLE_BOOT,
      );
      expect(child.status).toBe(1);
      expect(JSON.parse(child.stdout)).toMatchObject({
        kind: "refused",
        failure: {
          message: `renderer wire version mismatch (host sent ${sent}, expected version ${RENDERER_WIRE_VERSION})`,
        },
      });
    },
  );

  test("the built child starts with a compatible version and unrelated build identity", () => {
    const child = bootChild(COMPATIBLE_BOOT);
    expect(child.status).toBe(0);
    expect(
      child.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toContainEqual(
      expect.objectContaining({
        kind: "started",
        wireVersion: RENDERER_WIRE_VERSION,
      }),
    );
  });
});

// Every renderer start the daemon logged, by pid, in order.
function rendererStarts(handle: IsolatedDaemonHandle): number[] {
  const log = fs.readFileSync(path.join(handle.stateDir, "daemon.log"), "utf8");
  return [...log.matchAll(/renderer main\[\d+\] started pid=(\d+)/g)].map((m) =>
    Number(m[1]),
  );
}

describe("the daemon's renderer process", () => {
  let handle: IsolatedDaemonHandle;
  let projectDir: string;

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-rproc-"));
    handle = await spawnIsolatedDaemon("cc-candybar-rproc");
  });

  afterEach(async () => {
    await handle.cleanup();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test("draws the bar from its own process, and one killed is restarted with the bar saying so", async () => {
    const first = await render(handle.sockPath, "rproc", projectDir);
    expect(textOf(first).length).toBeGreaterThan(0);
    // Nothing is wrong before the end, so the warning that follows is its.
    expect(textOf(first)).not.toMatch(/⚠/);
    const [pid] = rendererStarts(handle);
    expect(pid).toBeDefined();
    expect(pid).not.toBe(handle.child.pid);

    process.kill(pid!, "SIGKILL");
    await until(
      () => rendererStarts(handle).length === 2,
      () => "the renderer to be started again",
      10_000,
    );
    expect(rendererStarts(handle)[1]).not.toBe(pid);

    // The restarted renderer configures the session again from the request
    // the daemon holds, and the bar warns of the end.
    const warned = await renderUntil(
      handle.sockPath,
      "rproc",
      projectDir,
      (frame) => /⚠/.test(textOf(frame)),
      "a bar warning that its renderer restarted",
      10_000,
    );
    expect(textOf(warned)).toMatch(/⚠ \d/);
    const log = fs.readFileSync(
      path.join(handle.stateDir, "daemon.log"),
      "utf8",
    );
    expect(log).toMatch(
      /renderer main\[1\] killed by SIGKILL after \d+ s; next start in 1 s/,
    );
  });

  test("publishes identical clickable addresses for a request and the tmux pane feed", async () => {
    const external = "https://example.test/page#section";
    const authored = "cc-candybar://open-vscode/fixture";
    const config = path.join(projectDir, "links.json5");
    fs.writeFileSync(
      config,
      `{
      globals: { experimentalPane: true },
      segments: {
        body: { template: 'DISCLOSURE-BODY' },
        external: { template: '{{ link "${external}" "external" }}' },
        authored: { template: '{{ link "${authored}" "authored" }}' },
      },
      root: { h: [
        { kind: 'group', name: 'details', label: 'details', open: true, children: ['body'] },
        'external',
        'authored',
      ] },
    }`,
    );
    const session = "rproc-links";
    const args = ["cc-candybar", "--config", config];
    const request = await render(
      handle.sockPath,
      session,
      projectDir,
      {},
      args,
    );
    expect(linksOf(request)).toContainEqual({
      url: external,
      text: "external",
    });
    const requestLink = linksOf(request).find(
      ({ text }) => text === DISCLOSURE_GLYPH_CLOSE,
    )?.url;
    if (requestLink === undefined)
      throw new Error("request has no disclosure close");
    expect(textOf(request)).toContain("DISCLOSURE-BODY");
    expect(requestLink).toBe(drawnLink(handle.sockPath, requestLink));
    const authoredLink = linksOf(request).find(
      ({ text }) => text === "authored",
    )?.url;
    if (authoredLink === undefined) throw new Error("request has no authored link");
    expect(authoredLink).toBe(drawnLink(handle.sockPath, authored));
    expect(effectsOf(authoredLink)).toEqual([
      { verb: VERB_OPEN_VSCODE, args: ["fixture"] },
    ]);
    const urlsOfAnsi = (output: string): string[] =>
      decodeAnsi(output).spans.flatMap(({ style }) =>
        style instanceof Style && style.link !== undefined ? [style.link] : [],
      );
    const ansi = await renderRequest(
      handle.sockPath,
      renderBody(session, projectDir, {}, args),
    );
    expect(urlsOfAnsi(ansi)).toEqual(
      expect.arrayContaining([requestLink, external, authoredLink]),
    );

    const frames: Response[] = [];
    let ended: StreamEnd | null = null;
    const stream = openFrameStream(
      handle.sockPath,
      session,
      "pane",
      (frame) => frames.push(frame),
      (end) => {
        ended = end;
      },
    );
    try {
      await until(
        () => frames.length > 0 || ended !== null,
        "the pane's first frame",
      );
      const frame = frames[0];
      if (frame === undefined || !frame.ok || !("output" in frame))
        throw new Error(
          `the pane drew no bar: ${JSON.stringify(frame ?? ended)}`,
        );
      const urls = urlsOfAnsi(frame.output);
      const paneLink = urls.find((url) => url === requestLink);
      expect(paneLink).toBe(requestLink);
      expect(urls).toContain(external);
      expect(urls).toContain(authoredLink);
      expect(decodeAnsi(frame.output).plain).toContain("DISCLOSURE-BODY");
      await click(handle.sockPath, paneLink!);
      await until(
        () =>
          frames.some(
            (reply) =>
              reply.ok &&
              "output" in reply &&
              !decodeAnsi(reply.output).plain.includes("DISCLOSURE-BODY"),
          ),
        "the pane after its click",
      );
    } finally {
      stream.close();
    }
  });

  test("admits the repository decision from an earlier frame", async () => {
    const init = spawnSync("git", ["-C", projectDir, "init", "-q"], {
      encoding: "utf8",
    });
    if (init.status !== 0) throw new Error(`git init: ${init.stderr}`);
    fs.writeFileSync(
      path.join(projectDir, ".cc-candybar.json5"),
      JSON.stringify({
        segments: { agreed: { template: "REPOSITORY-APPROVED" } },
        root: { h: ["agreed"] },
      }),
    );
    const session = "rproc-repo";
    const draw = () => render(handle.sockPath, session, projectDir);
    const before = await draw();
    expect(textOf(before)).not.toContain("REPOSITORY-APPROVED");
    const pages = await readDiagnostics(
      handle.sockPath,
      session,
      projectDir,
      before,
    );
    const approve = findUrl(
      pages.flatMap(({ rendered }) => linksOf(rendered).map(({ url }) => url)),
      (effects) =>
        effects.some(
          ({ verb, args }) => verb === VERB_REPO_CONFIG && args[2] === "approved",
        ),
    );
    if (approve === undefined) throw new Error("missing repository approval");
    const later = await draw();
    expect(textOf(later)).not.toContain("REPOSITORY-APPROVED");
    await click(handle.sockPath, approve, 20_000);
    expect(textOf(await draw())).toContain("REPOSITORY-APPROVED");
  });

  test("a run from an earlier frame keeps its drawn arguments and environment", async () => {
    const config = path.join(projectDir, "run.json5");
    const record = path.join(projectDir, "observed.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        variables: {
          shown: { kind: "input", path: "model.display_name", type: "string" },
        },
        actions: {
          remember: {
            run: [
              process.execPath,
              "-e",
              'require("node:fs").writeFileSync(process.argv[1], JSON.stringify([process.argv[2], process.env.DRAWN]))',
              record,
              "{{ .shown }}",
            ],
            env: { DRAWN: "{{ .shown }}" },
          },
        },
        segments: { saved: { template: '{{ action "remember" .shown }}' } },
        root: { h: ["saved"] },
      }),
    );
    const session = "rproc-run";
    const args = ["cc-candybar", "--config", config];
    const draw = (value: string) =>
      frameRequest(handle.sockPath, {
        ...renderBody(session, projectDir, {}, args),
        hookData: {
          ...hookData(session, projectDir),
          model: { id: "fixture", display_name: value },
        },
      });
    const before = await draw("first value");
    const old = linksOf(before).find(
      ({ text, url }) =>
        text === "first value" && effectsOf(url).some(({ verb }) => verb === VERB_RUN),
    )?.url;
    if (old === undefined) throw new Error("missing run from the first frame");
    expect(textOf(await draw("second value"))).toContain("second value");
    await click(handle.sockPath, old);
    const wanted = JSON.stringify(["first value", "first value"]);
    await until(
      () => fs.existsSync(record) && fs.readFileSync(record, "utf8") === wanted,
      "the run's captured argv and env",
    );
  });

  test("a renderer outlives no daemon, even one killed with no cleanup", async () => {
    await render(handle.sockPath, "rproc", projectDir);
    const [pid] = rendererStarts(handle);
    const alive = (): boolean => {
      try {
        process.kill(pid!, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    // The renderer is launched detached and leads a group of its own, so no
    // signal to the daemon's group reaches it; its end here can only be the
    // daemon's lifeline. The renderer's parent is the process the test holds,
    // so that pid is the daemon's own.
    const parent = Number(
      spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
      }).stdout.trim(),
    );
    expect(parent).toBe(handle.child.pid);
    process.kill(parent, "SIGKILL");
    await until(
      () => !alive(),
      () => `renderer ${pid} to end with its daemon`,
      10_000,
    );
  });
});
