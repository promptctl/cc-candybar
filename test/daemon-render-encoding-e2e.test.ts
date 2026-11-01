// [LAW:verifiable-goals] candybar-isolated-daemon-bfab.dnr: a one-shot reader
// asks one daemon for the Frame, and what it reads is what a terminal is sent:
// the same request in both encodings answers one draw, closed and open, at every
// depth. The daemon's clock is held, so the two draws are one instant and a bar
// reading the instant cannot tell them apart.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { linksOf } from "../src/click/read";
import { DOOR_GLYPH } from "../src/config/disclosure";
import { PROTOCOL_VERSION, type Response } from "../src/daemon/protocol";
import { composeBar, parseFrame } from "../src/render/frame";
import {
  COLOR_COMPATIBILITIES,
  type ColorCompatibility,
} from "../src/themes/policy";
import {
  click,
  frameRequest,
  renderBody,
  renderRequest,
} from "./helpers/daemon-e2e";
import { logLines } from "./helpers/daemon-log";
import { sendDaemonRequest } from "./helpers/daemon-wire";
import {
  heldClock,
  startDaemon,
  type InWorkerDaemon,
} from "./helpers/in-worker-daemon";
import { field, landedEvents } from "./helpers/request-event";
import { prepareIsolatedDaemonEnv } from "./helpers/spawn-isolated-daemon";
import { until } from "./helpers/until";

jest.setTimeout(30_000);

const HINTS = { termCols: 120, termRows: 40 };
const STILL = `{ segments: { mark: { template: 'mark' } }, root: { h: ['mark'] } }`;

describe("a render answers in the encoding it asks for", () => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let daemon: InWorkerDaemon;

  const configAt = (name: string, text: string): string[] => {
    const file = path.join(projectDir, `${name}.json5`);
    writeFileSync(file, text);
    return ["cc-candybar", "--config", file];
  };
  // A daemon's refused request names no session, so it is found by its words.
  const refusedLines = (word: string): string[] =>
    logLines(env).filter(
      (l) => / \[\w+\] render /.test(l) && l.includes(word),
    );

  beforeAll(() => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-encoding-e2e");
    ({ env, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-encoding-"));
    daemon = startDaemon(prepared.env, { clock: heldClock() });
  });

  afterAll(async () => {
    await daemon?.stop();
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  // One render sent once, where a retrying helper logs an event per attempt.
  const send = (request: Record<string, unknown>): Promise<Response> =>
    sendDaemonRequest(daemon, {
      v: PROTOCOL_VERSION,
      kind: "render",
      deadline: daemon.now() + 5000,
      ...request,
    });

  test.each(COLOR_COMPATIBILITIES)(
    "at %s, a Frame's bytes are the reply's, closed and open",
    async (depth: ColorCompatibility) => {
      const sid = `frame-bytes-${depth}`;
      const body = renderBody(
        sid,
        projectDir,
        HINTS,
        configAt(depth, `{ globals: { colorCompatibility: '${depth}' } }`),
      );
      const closed = await frameRequest(daemon, body);
      expect(composeBar(closed)).toBe(await renderRequest(daemon, body));
      expect(closed.depth).toBe(depth);
      const door = linksOf(closed).find((l) => l.text === DOOR_GLYPH);
      await click(daemon, door!.url);
      const output = await renderRequest(daemon, body);
      const opened = await frameRequest(daemon, body);
      expect(composeBar(opened)).toBe(output);
      expect(opened.rows.length).toBeGreaterThan(closed.rows.length);
      expect(linksOf(opened).length).toBeGreaterThan(linksOf(closed).length);
      // What the wire carries beside text and links: at `none` a run has no look.
      const runs = opened.rows.flatMap((row) => row.runs);
      expect(runs.some((run) => run.bg !== undefined)).toBe(depth !== "none");
      expect(runs.some((run) => (run.attrs ?? []).length > 0)).toBe(
        depth !== "none",
      );
    },
  );

  test("a still bar's nextChange crosses the wire as null and reads back as Infinity", async () => {
    const resp = await send({
      encoding: "frame",
      ...renderBody("still", projectDir, HINTS, configAt("still", STILL)),
    });
    const { frame } = resp as Extract<Response, { frame: unknown }>;
    expect(frame.nextChange).toBeNull();
    expect(parseFrame(frame).nextChange).toBe(Infinity);
  });

  test("a value that is not an encoding is refused, never read as ansi", async () => {
    const resp = await send({
      encoding: "yaml",
      ...renderBody("refused", projectDir, HINTS),
    });
    expect(resp).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(resp).toMatchObject({ error: expect.stringContaining('"yaml"') });
    await until(
      () => refusedLines('\\"yaml\\"').length > 0,
      "the refused render's event",
    );
    expect(refusedLines('\\"yaml\\"')[0]).toContain("outcome=bad-request");
  });

  test("the render event names the encoding each answer took, an unstated one reading ansi", async () => {
    const sid = "named";
    const body = renderBody(sid, projectDir, HINTS, configAt("named", STILL));
    await send(body);
    await send({ ...body, encoding: "ansi" });
    await send({ ...body, encoding: "frame" });
    const events = await landedEvents(env, sid, 3);
    expect(events.map((e) => field(e, "encoding"))).toEqual([
      "ansi",
      "ansi",
      "frame",
    ]);
  });
});
