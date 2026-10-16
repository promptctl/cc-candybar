import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paint } from "../src/bar-pane/paint";
import { readRecording, recordingPath } from "../src/bar-pane/recording";

describe("bar-pane paint", () => {
  it("redraws from the pane's top-left, one erased line per bar line", () => {
    expect(paint("row one\nrow two")).toEqual({
      bytes: "\x1b[H\x1b[2Krow one\r\n\x1b[2Krow two\x1b[J",
      rows: 2,
    });
  });

  // A trailing newline would move the cursor past a pane exactly as tall as
  // the frame and scroll its first line away.
  it("ends on the last line, whatever newlines the frame ends with", () => {
    expect(paint("only\n\n")).toEqual(paint("only"));
    expect(paint("only").rows).toBe(1);
  });
});

describe("bar-pane recording", () => {
  const prior = process.env.XDG_STATE_HOME;
  let state: string;
  const anim = {
    socket: "/private/tmp/tmux-501/anim",
    pane: "%9",
    truecolor: null,
  };
  const other = { ...anim, socket: "/private/tmp/tmux-501/default" };

  beforeEach(() => {
    state = fs.mkdtempSync(path.join(os.tmpdir(), "bar-pane-"));
    process.env.XDG_STATE_HOME = state;
  });
  afterEach(() => {
    // Assigning undefined would leave the string "undefined" set.
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    fs.rmSync(state, { recursive: true, force: true });
  });

  it("is absent until the pane's statusline records, naming where it looked", () => {
    expect(readRecording(anim, "%3")).toEqual({
      kind: "absent",
      path: path.join(state, "cc-candybar", "bar-pane", "anim%3.json"),
    });
  });

  // Pane ids restart at %0 on every tmux server, so one server's recording
  // must never answer for another's pane.
  it("reads the payload recorded for that pane on that server only", () => {
    const file = recordingPath(anim, "%3");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ session_id: "s1" }));
    expect(readRecording(anim, "%3")).toEqual({
      kind: "recorded",
      hookData: { session_id: "s1" },
    });
    expect(readRecording(other, "%3").kind).toBe("absent");
  });

  // The script and recordingPath spell one path in two languages.
  it("finds what the recorder script recorded, and the script passes the payload on", () => {
    const payload = JSON.stringify({ session_id: "s2" });
    const out = execFileSync(
      path.join(__dirname, "..", "scripts", "bar-pane", "record-statusline"),
      ["cat"],
      {
        input: payload,
        encoding: "utf8",
        env: {
          ...process.env,
          XDG_STATE_HOME: state,
          TMUX: `${anim.socket},123,0`,
          TMUX_PANE: "%3",
        },
      },
    );
    expect(out).toBe(payload);
    expect(readRecording(anim, "%3")).toEqual({
      kind: "recorded",
      hookData: { session_id: "s2" },
    });
  });

  it("throws on a recording it cannot parse", () => {
    const file = recordingPath(anim, "%3");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ half");
    expect(() => readRecording(anim, "%3")).toThrow(SyntaxError);
  });
});
