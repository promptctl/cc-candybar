// brandon-doctor-v62x.2ww: the `terminalEnv` client hint — what the client
// reports and what the daemon's checkpoint admits. The table is the one
// rust-client's terminal_env_hint_reports_exactly_what_the_ts_client_reports
// pins, so the two runtimes report a session's terminal alike.

import { detectTerminalEnv } from "../src/terminal-hint";
import { parseClientHints } from "../src/daemon/protocol";

describe("detectTerminalEnv", () => {
  test("reports each set variable raw and leaves out the unset and the empty", () => {
    expect(detectTerminalEnv({})).toEqual({});
    expect(detectTerminalEnv({ TERM_PROGRAM: "", TERM: "" })).toEqual({});
    expect(detectTerminalEnv({ TERM_PROGRAM: "iTerm.app" })).toEqual({
      TERM_PROGRAM: "iTerm.app",
    });
    expect(
      detectTerminalEnv({ TERM_PROGRAM: "tmux", TERM: "xterm-kitty" }),
    ).toEqual({ TERM_PROGRAM: "tmux", TERM: "xterm-kitty" });
  });

  test("reads only its own vocabulary", () => {
    expect(
      detectTerminalEnv({
        ITERM_PROFILE: "Default",
        TERM_PROGRAM_VERSION: "3.7.2",
        COLORTERM: "truecolor",
      }),
    ).toEqual({ ITERM_PROFILE: "Default", TERM_PROGRAM_VERSION: "3.7.2" });
  });
});

describe("the checkpoint", () => {
  const parsed = (v: unknown) =>
    parseClientHints({ terminalEnv: v }).terminalEnv;

  test("an absent hint is unreported", () => {
    expect(parseClientHints({}).terminalEnv).toBeUndefined();
  });

  test("an object of the vocabulary's strings is the hint, other keys dropped", () => {
    expect(parsed({})).toEqual({});
    expect(parsed({ TERM_PROGRAM: "ghostty", EXTRA: "x" })).toEqual({
      TERM_PROGRAM: "ghostty",
    });
  });

  test.each([[null], [[]], ["ghostty"], [{ TERM: 1 }], [{ TERM: "" }]])(
    "a malformed hint (%p) is unreported, never half-true",
    (v) => {
      expect(parsed(v)).toBeUndefined();
    },
  );
});
