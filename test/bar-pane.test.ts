import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paint } from "../src/bar-pane/paint";
import {
  readRecording,
  recordingPath,
  serverOf,
} from "../src/bar-pane/recording";

const RECORDER = path.join(
  __dirname,
  "..",
  "scripts",
  "bar-pane",
  "record-statusline",
);

describe("bar-pane paint", () => {
  it("places each bar line on its own row and erases what is below", () => {
    expect(paint("row one\nrow two")).toEqual({
      bytes: "\x1b[1H\x1b[2Krow one\x1b[2H\x1b[2Krow two\x1b[J",
      rows: 2,
    });
  });

  // A newline at the pane's bottom row would scroll its first line away.
  it("writes no newline, whatever newlines the frame ends with", () => {
    expect(paint("only\n\n")).toEqual(paint("only"));
    expect(paint("a\nb\nc").bytes).not.toMatch(/[\r\n]/);
  });
});

describe("bar-pane recording", () => {
  const prior = process.env.XDG_STATE_HOME;
  let state: string;
  const socket = "/private/tmp/tmux-501/anim";

  beforeEach(() => {
    state = fs.mkdtempSync(path.join(os.tmpdir(), "bar-pane-"));
    process.env.XDG_STATE_HOME = state;
  });
  afterEach(() => {
    // Assigning undefined would leave the string "undefined" set.
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    fs.chmodSync(state, 0o700);
    fs.rmSync(state, { recursive: true, force: true });
  });

  const record = (args: readonly string[], env: Record<string, string>) =>
    execFileSync(RECORDER, args, {
      input: JSON.stringify({ session_id: "s2" }),
      encoding: "utf8",
      cwd: state,
      env: { PATH: process.env.PATH!, XDG_STATE_HOME: state, ...env },
    });

  // Pane ids restart at %0 on every tmux server run, so the run's pid is part
  // of the key: a restarted server's pane never reads the last run's record.
  it("names one server run by its socket's file name and pid", () => {
    expect(serverOf(`${socket},123,0`)).toBe("anim,123");
    expect(serverOf(`${socket},456,0`)).not.toBe(serverOf(`${socket},123,0`));
  });

  it("is absent until the pane's statusline records, naming where it looked", () => {
    expect(readRecording("anim,123", "%3")).toEqual({
      kind: "absent",
      path: path.join(state, "cc-candybar", "bar-pane", "anim,123%3"),
    });
  });

  // The script and recordingPath spell one path and one layout in two
  // languages; the bar pane replays exactly what the statusline was run with.
  it("replays the statusline's payload, cwd, argv and environment, and passes the payload on", () => {
    const env = {
      TMUX: `${socket},123,0`,
      TMUX_PANE: "%3",
      CLAUDE_CONFIG_DIR: "/home/u/.claude.zai",
      MULTI: "two\nlines",
    };
    const argv = ["sh", "-c", "cat", "sh", "--config", "my bar.json5"];
    const out = record(argv, env);
    expect(JSON.parse(out)).toEqual({ session_id: "s2" });
    expect(readRecording(serverOf(env.TMUX), "%3")).toEqual({
      kind: "recorded",
      invocation: {
        hookData: { session_id: "s2" },
        cwd: fs.realpathSync(state),
        argv,
        env: expect.objectContaining(env),
      },
    });
    expect(readRecording(serverOf(`${socket},456,0`), "%3").kind).toBe(
      "absent",
    );
    // The environment holds the session's secrets.
    expect(
      fs.statSync(recordingPath(serverOf(env.TMUX), "%3")).mode & 0o077,
    ).toBe(0);
  });

  it("still hands the statusline its payload when it cannot record", () => {
    fs.chmodSync(state, 0o500);
    const out = record(["cat"], { TMUX: `${socket},123,0`, TMUX_PANE: "%3" });
    expect(JSON.parse(out)).toEqual({ session_id: "s2" });
  });

  it("throws, naming the file, on a record it cannot parse", () => {
    const file = recordingPath("anim,123", "%3");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ half\0/\x000\0");
    expect(() => readRecording("anim,123", "%3")).toThrow(file);
    fs.writeFileSync(file, "{}");
    expect(() => readRecording("anim,123", "%3")).toThrow(file);
  });
});
