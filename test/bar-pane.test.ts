import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paint } from "../src/bar-pane/paint";
import {
  readRecording,
  recordingPath,
  removeRecording,
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
        // The test's stderr is a pipe: the client's ioctl would answer nothing.
        tty: {},
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

  const write = (text: string) => {
    const file = recordingPath("anim,123", "%3");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };

  it("reads the size the statusline's terminal answered", () => {
    write('{}\0/\x0040 120\x000\0A=1\0');
    const recording = readRecording("anim,123", "%3");
    expect(recording.kind === "recorded" && recording.invocation).toEqual({
      hookData: {},
      cwd: "/",
      tty: { rows: 40, columns: 120 },
      argv: [],
      env: { A: "1" },
    });
  });

  // The record holds the session's environment, so it goes when the bar pane
  // sees the session's pane close; a pane that never recorded is no fault.
  it("removes the record, and is absent after", () => {
    write("{}\0/\0\x000\0");
    removeRecording("anim,123", "%3");
    expect(readRecording("anim,123", "%3").kind).toBe("absent");
    expect(() => removeRecording("anim,123", "%3")).not.toThrow();
  });

  it.each([
    ["a payload that is not JSON", "{ half\0/\0\x000\0"],
    ["no record at all", "{}"],
    ["a record cut short of its last NUL", "{}\0/\0\x000\0A=1"],
    ["an environment entry with no value", "{}\0/\0\x000\0A=1\0B\0"],
    ["a size that is not rows and columns", "{}\0/\x00wide\x000\0"],
    ["an empty argc", "{}\0/\0\0\0A=1\0"],
    ["a negative argc", "{}\0/\0\0-1\0A=1\0"],
  ])("throws, naming the file, on %s", (_, text) => {
    const file = write(text);
    expect(() => readRecording("anim,123", "%3")).toThrow(file);
  });
});
