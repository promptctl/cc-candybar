// [LAW:parse-dont-validate] The record verb's two checkpoints: the daemon's
// parse of a record request off the wire, and the CLI's parse of its
// arguments, and the CLI's fold of the answer into what a person sees — a
// recording no request was answered in is a failure said now.

import {
  DEFAULT_RECORD_SECONDS,
  parseRecordArgs,
  recordPlan,
} from "../../src/daemon/client-record";
import {
  MAX_RECORD_SECONDS,
  PROTOCOL_VERSION,
  type RecordRequest,
} from "../../src/daemon/protocol";
import { parseRecordRequest } from "../../src/daemon/reply";

const SID = "rec0a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b";

const wire = (over: Partial<Record<keyof RecordRequest, unknown>>) =>
  ({
    v: PROTOCOL_VERSION,
    kind: "record",
    session: SID,
    path: "/tmp/bar.jsonl",
    seconds: 10,
    ...over,
  }) as RecordRequest;

describe("a record request off the wire", () => {
  test("is the session, an absolute path and a positive span", () => {
    expect(parseRecordRequest(wire({}))).toEqual({
      ok: true,
      session: SID,
      path: "/tmp/bar.jsonl",
      seconds: 10,
    });
  });

  test("is refused naming the field it got wrong", () => {
    expect(parseRecordRequest(wire({ path: "bar.jsonl" }))).toEqual({
      ok: false,
      problem: 'record\'s path is not an absolute path: "bar.jsonl"',
    });
    for (const seconds of [0, -1, Number.NaN, "10", MAX_RECORD_SECONDS + 1]) {
      expect(parseRecordRequest(wire({ seconds }))).toMatchObject({
        ok: false,
        problem: expect.stringMatching(
          /^record.s seconds .* is not a span of seconds above 0 and at most /,
        ),
      });
    }
    expect(parseRecordRequest(wire({ session: 7 }))).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/^record's session /),
    });
  });
});

describe("the record command", () => {
  test("resolves its path against the shell's directory and records ten seconds unless told", () => {
    expect(parseRecordArgs([SID, "out/bar.jsonl"], "/work")).toEqual({
      ok: true,
      args: {
        session: SID,
        path: "/work/out/bar.jsonl",
        seconds: DEFAULT_RECORD_SECONDS,
      },
    });
    expect(
      parseRecordArgs([SID, "/abs/bar.jsonl", "--seconds", "3"], "/work"),
    ).toEqual({
      ok: true,
      args: { session: SID, path: "/abs/bar.jsonl", seconds: 3 },
    });
  });

  test("refuses arguments it cannot record with", () => {
    expect(parseRecordArgs([SID], "/work")).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/^usage: cc-candybar record/),
    });
    expect(parseRecordArgs([SID, "a", "b"], "/work")).toMatchObject({
      ok: false,
    });
    expect(parseRecordArgs([SID, "a", "--seconds"], "/work")).toEqual({
      ok: false,
      problem: "--seconds needs a number after it",
    });
    expect(parseRecordArgs([SID, "a", "--seconds", "soon"], "/work")).toEqual({
      ok: false,
      problem: `--seconds "soon" is not a span of seconds above 0 and at most ${MAX_RECORD_SECONDS}`,
    });
    // A span no timer holds would fire at once, so it is refused here.
    expect(
      parseRecordArgs(
        [SID, "a", "--seconds", String(MAX_RECORD_SECONDS + 1)],
        "/work",
      ),
    ).toMatchObject({ ok: false });
    expect(parseRecordArgs([SID, "a", "--loud"], "/work")).toEqual({
      ok: false,
      problem: 'unexpected argument "--loud"',
    });
  });

  test("says what it wrote and exits 0, or exits 1 when no request was answered", () => {
    expect(
      recordPlan(
        {
          kind: "ok",
          value: {
            path: "/w/bar.jsonl",
            lines: 9,
            requests: 3,
            daemonClosed: false,
          },
        },
        10,
      ),
    ).toEqual({
      stdout: "/w/bar.jsonl: 9 lines, 3 requests\n",
      stderr: "",
      code: 0,
    });
    const idle = recordPlan(
      {
        kind: "ok",
        value: {
          path: "/w/bar.jsonl",
          lines: 2,
          requests: 0,
          daemonClosed: false,
        },
      },
      10,
    );
    expect(idle.code).toBe(1);
    expect(idle.stdout).toBe("");
    expect(idle.stderr).toMatch(
      /^record: \/w\/bar\.jsonl: no request was answered in 10s, so there is nothing to replay: the session was idle/,
    );
  });

  test("a recording the daemon's close cut short says so: a short file is kept with the note, an empty one is a failure that blames the close", () => {
    const short = recordPlan(
      {
        kind: "ok",
        value: {
          path: "/w/bar.jsonl",
          lines: 9,
          requests: 3,
          daemonClosed: true,
        },
      },
      10,
    );
    expect(short).toMatchObject({
      stdout: "/w/bar.jsonl: 9 lines, 3 requests\n",
      code: 0,
    });
    expect(short.stderr).toBe(
      "record: the daemon closed before 10s ran out: the file holds what came before.\n",
    );
    const empty = recordPlan(
      {
        kind: "ok",
        value: {
          path: "/w/bar.jsonl",
          lines: 2,
          requests: 0,
          daemonClosed: true,
        },
      },
      10,
    );
    expect(empty.code).toBe(1);
    expect(empty.stderr).toMatch(
      /^record: \/w\/bar\.jsonl: the daemon closed before 10s ran out, and no request had been answered/,
    );
    expect(empty.stderr).not.toMatch(/idle/);
  });

  test("a refusal from the daemon is the command's failure, said on stderr", () => {
    const plan = recordPlan(
      {
        kind: "permanent",
        cause: "bad_request",
        message: 'no view of session "x" is open in this daemon',
      },
      10,
    );
    expect(plan.code).toBe(1);
    expect(plan.stderr).toContain(
      'no view of session "x" is open in this daemon',
    );
  });
});
