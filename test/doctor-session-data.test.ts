import { execFileSync } from "node:child_process";
// brandon-doctor-v62x.p4l: "Session data is readable" — the transcript each
// recent render named exists once Claude Code has answered, opens, and reads
// as the JSON lines the bar folds its session cost, metrics and activity from.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkByName,
  RECENT_CLIENT_S,
  TRANSCRIPT_WINDOW_BYTES,
  type DoctorFacts,
  type TranscriptRead,
  type TranscriptWindow,
} from "../src/doctor/checks";
import { readTranscriptWindow, transcriptWindow } from "../src/doctor/edge";
import { parseTranscriptSightings } from "../src/doctor/daemon-answer";
import { transcriptsOf } from "../src/doctor/cli";
import { transcriptFields } from "../src/doctor/report";
import { transcriptSaid } from "../src/daemon/render-sightings";
import type { StatsSnapshot } from "../src/daemon/stats";
import { HEALTHY_FACTS } from "./helpers/doctor-facts";

const sessionData = checkByName("sessionData")!;

const probe = (
  transcripts: DoctorFacts["transcripts"],
  sighted: DoctorFacts["sighted"] = { kind: "recent" },
) => sessionData.probe({ ...HEALTHY_FACTS, transcripts, sighted });

const read = (
  answered: boolean,
  outcome: TranscriptRead["read"],
  file = "/t/s.jsonl",
): TranscriptRead => ({ path: file, answered, read: outcome });

const window = (value: TranscriptWindow) => ({ kind: "ok", value }) as const;

describe("transcriptWindow", () => {
  const bytes = (text: string) => Buffer.from(text, "utf-8");

  test("a whole file of JSON objects has no unparsed line", () => {
    expect(transcriptWindow(bytes(`{"a":1}\n\n{"b":2}\n`), true)).toEqual({
      lines: 2,
      unparsed: 0,
      whole: true,
    });
  });

  test("a line that is not JSON, or JSON that is no object, is unparsed", () => {
    expect(
      transcriptWindow(bytes(`{"a":1}\nnot json\nnull\n[1]\n7\n`), true),
    ).toEqual({ lines: 5, unparsed: 4, whole: true });
  });

  test("a window inside the file leaves its cut first line unjudged", () => {
    expect(transcriptWindow(bytes(`":1}\n{"b":2}\n`), false)).toEqual({
      lines: 1,
      unparsed: 0,
      whole: false,
    });
  });

  test("a last line still being written is not judged", () => {
    expect(transcriptWindow(bytes(`{"a":1}\n{"b":`), true)).toEqual({
      lines: 1,
      unparsed: 0,
      whole: true,
    });
  });

  test("a window with no complete line holds none", () => {
    expect(transcriptWindow(bytes(`{"partial`), false)).toEqual({
      lines: 0,
      unparsed: 0,
      whole: false,
    });
  });
});

describe("readTranscriptWindow", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-transcript-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("no file at the path is absent", () => {
    expect(readTranscriptWindow(path.join(dir, "none.jsonl"))).toEqual({
      kind: "absent",
    });
  });

  test("a path that cannot be read as a file fails with the reason", () => {
    const outcome = readTranscriptWindow(dir);
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.reason).toBe("not a regular file");
  });

  test("a file reads whole", () => {
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, `{"a":1}\n{oops\n`);
    expect(readTranscriptWindow(file)).toEqual(
      window({ lines: 2, unparsed: 1, whole: true }),
    );
  });

  test("a window that starts on a line boundary judges its first line", () => {
    const file = path.join(dir, "s.jsonl");
    const bad = "not json\n";
    const fill = `${JSON.stringify({ p: "x".repeat(TRANSCRIPT_WINDOW_BYTES - bad.length - 9) })}\n`;
    expect(bad.length + fill.length).toBe(TRANSCRIPT_WINDOW_BYTES);
    fs.writeFileSync(file, `{"a":1}\n${bad}${fill}`);
    expect(readTranscriptWindow(file)).toEqual(
      window({ lines: 2, unparsed: 1, whole: false }),
    );
  });

  // A pipe is no transcript: the read neither blocks nor reports one empty.
  test("a FIFO at the path does not block the read, and is no file", () => {
    const fifo = path.join(dir, "pipe.jsonl");
    execFileSync("mkfifo", [fifo]);
    expect(readTranscriptWindow(fifo)).toEqual({
      kind: "failed",
      reason: "not a regular file",
    });
  });

  test("a file past the window reads only its last window", () => {
    const file = path.join(dir, "s.jsonl");
    const line = `${JSON.stringify({ pad: "x".repeat(1000) })}\n`;
    const count = Math.ceil((2 * TRANSCRIPT_WINDOW_BYTES) / line.length);
    fs.writeFileSync(file, `not json\n${line.repeat(count)}`);
    const outcome = readTranscriptWindow(file);
    expect(outcome.kind).toBe("ok");
    const value = (outcome as { value: TranscriptWindow }).value;
    expect(value.whole).toBe(false);
    expect(value.unparsed).toBe(0);
    expect(value.lines).toBeLessThan(count);
  });
});

describe("the session data row", () => {
  test("a transcript that reads as JSON lines is ok", () => {
    expect(
      probe({
        kind: "ok",
        value: [read(true, window({ lines: 9, unparsed: 0, whole: true }))],
      }),
    ).toEqual({ ok: true });
  });

  test("no transcript before Claude Code has answered is no finding", () => {
    expect(probe({ kind: "ok", value: [read(false, { kind: "absent" })] })).toEqual({
      ok: true,
    });
  });

  test("no transcript once Claude Code has answered fails, naming it", () => {
    expect(probe({ kind: "ok", value: [read(true, { kind: "absent" })] })).toEqual({
      ok: false,
      reason:
        "the transcript /t/s.jsonl does not exist, though Claude Code has answered in its session — the bar's session cost, metrics and activity read nothing",
      more: [],
    });
  });

  test("a transcript that cannot be read fails with the reason", () => {
    expect(
      probe({
        kind: "ok",
        value: [read(false, { kind: "failed", reason: "EACCES: permission denied" })],
      }),
    ).toEqual({
      ok: false,
      reason: "the transcript /t/s.jsonl cannot be read: EACCES: permission denied",
      more: [],
    });
  });

  test("lines that are not JSON objects fail, counted over the window read", () => {
    expect(
      probe({
        kind: "ok",
        value: [
          read(true, window({ lines: 9, unparsed: 2, whole: true })),
          read(true, window({ lines: 9, unparsed: 1, whole: false }), "/t/b.jsonl"),
        ],
      }),
    ).toEqual({
      ok: false,
      reason:
        "2 of the 9 lines in the transcript /t/s.jsonl are not JSON objects — the bar skips them, so what it counts from them is missing",
      more: [
        "1 of the 9 lines in the last 1 MiB of the transcript /t/b.jsonl are not JSON objects — the bar skips them, so what it counts from them is missing",
      ],
    });
  });

  test("no render to name a transcript fails, worded for what asked", () => {
    const none = { kind: "ok", value: [] } as const;
    expect(probe(none, { kind: "clicked", sessionId: "s1", via: "link" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /^this daemon holds no render of this bar .*so which transcript it reads is unknown/,
      ),
    });
    expect(probe(none, { kind: "recent" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /^no session has drawn a bar for this daemon in the last 5 minutes/,
      ),
    });
  });

  test("renders that could not be asked fail with the reason", () => {
    expect(probe({ kind: "failed", reason: "no daemon" })).toEqual({
      ok: false,
      reason: "no daemon",
    });
  });
});

test("a render's transcript is answered once Claude Code has a response", () => {
  const usage = {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const said = (current_usage: typeof usage | null) =>
    transcriptSaid({
      transcript_path: "/t/s.jsonl",
      context_window: { current_usage } as never,
    });
  expect(said(usage)).toEqual({ path: "/t/s.jsonl", answered: true });
  expect(said(null)).toEqual({ path: "/t/s.jsonl", answered: false });
});

test("a Claude Code that leaves no mark has not shown it answered", () => {
  // Before 2.0.70 there is no current_usage; before that, no context_window.
  expect(
    transcriptSaid({
      transcript_path: "/t/s.jsonl",
      context_window: {} as never,
    }),
  ).toEqual({ path: "/t/s.jsonl", answered: false });
  expect(transcriptSaid({ transcript_path: "/t/s.jsonl" })).toEqual({
    path: "/t/s.jsonl",
    answered: false,
  });
});

describe("the CLI's transcripts", () => {
  const stats = (clients: unknown[]) =>
    ({ version: "9.9.9", clients }) as unknown as StatsSnapshot;
  const t = { path: "/t/s.jsonl", answered: true };

  test("a daemon from before transcripts are recorded fails, saying to restart it", () => {
    expect(
      parseTranscriptSightings(
        stats([{ client: null, rateLimits: "carried", claudeConfigDir: "/c", ago: 1 }]),
      ),
    ).toEqual({
      kind: "failed",
      reason: expect.stringMatching(
        /^the running daemon \(9\.9\.9\) reported its renders without their transcripts — restart it on this build/,
      ),
    });
  });

  test("only the sessions that drew a bar recently are judged", () => {
    const parsed = parseTranscriptSightings(
      stats([
        { transcript: t, sessionId: "s1", ago: 1 },
        { transcript: { path: "/old.jsonl", answered: true }, sessionId: "s2", ago: RECENT_CLIENT_S + 1 },
      ]),
    );
    expect(transcriptsOf({ kind: "recent" }, parsed)).toEqual({ kind: "ok", value: [t] });
    // In a session's shell, that session's alone, however long ago.
    expect(transcriptsOf({ kind: "shell", sessionId: "s2" }, parsed)).toEqual({
      kind: "ok",
      value: [{ path: "/old.jsonl", answered: true }],
    });
  });
});

test("the doctor's event counts the transcripts by what reading found", () => {
  expect(
    transcriptFields({
      kind: "ok",
      value: [
        read(true, window({ lines: 9, unparsed: 2, whole: true })),
        read(true, window({ lines: 9, unparsed: 1, whole: false })),
        read(false, { kind: "absent" }),
        read(true, { kind: "failed", reason: "EIO" }),
      ],
    }),
  ).toBe("transcripts=2/1/1 unparsed=3");
  expect(transcriptFields({ kind: "failed", reason: "x" })).toBe(
    "transcripts=failed",
  );
});
