// [LAW:behavior-not-structure] The judge's contract, through `judgeRun` alone:
// a run whose read, parse and refresh the host may ask of the world is
// accepted as the same object; a run that asks for a relative path, a pattern
// that does not compile or captures nothing, or a shell period under the floor
// is refused with the reason the host reports.

import { judgeRun, MIN_SHELL_TTL_MS } from "../../src/daemon/judge-run";
import { runOf } from "../../src/facts/source-identity";

describe("judgeRun", () => {
  it("accepts a shell run and returns the same run object", () => {
    const run = runOf({
      read: { kind: "shell", command: "echo", cwd: "/" },
      parse: { kind: "text" },
      refresh: { kind: "ttl", durationMs: 500 },
    });
    const result = judgeRun(run);
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") expect(result.run).toBe(run);
  });

  it("accepts a file run with an absolute path, a capturing regex and a watched file", () => {
    const run = runOf({
      read: { kind: "file", path: "/etc/hosts", readMode: "whole" },
      parse: { kind: "regex", pattern: "(\\w+)" },
      refresh: { kind: "watch_file", path: "/etc/hosts" },
    });
    const result = judgeRun(run);
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") expect(result.run).toBe(run);
  });

  it("refuses a file path that is relative or starts with ~", () => {
    const relative = runOf({
      read: { kind: "file", path: "status.json", readMode: "whole" },
      parse: { kind: "text" },
      refresh: { kind: "never" },
    });
    expect(judgeRun(relative)).toEqual({
      kind: "refused",
      reason:
        'file.path must be an absolute path (`~` and relative paths are not expanded), got "status.json"',
    });

    const home = runOf({
      read: { kind: "file", path: "~/x", readMode: "whole" },
      parse: { kind: "text" },
      refresh: { kind: "never" },
    });
    expect(judgeRun(home)).toEqual({
      kind: "refused",
      reason:
        'file.path must be an absolute path (`~` and relative paths are not expanded), got "~/x"',
    });
  });

  it("refuses a watch_file path that is relative on an otherwise valid file run", () => {
    const run = runOf({
      read: { kind: "file", path: "/etc/hosts", readMode: "whole" },
      parse: { kind: "text" },
      refresh: { kind: "watch_file", path: "status.json" },
    });
    expect(judgeRun(run)).toEqual({
      kind: "refused",
      reason:
        'cache.watch_file must be an absolute path (`~` and relative paths are not expanded), got "status.json"',
    });
  });

  it("refuses a regex that does not compile", () => {
    const run = runOf({
      read: { kind: "file", path: "/etc/hosts", readMode: "whole" },
      parse: { kind: "regex", pattern: "(" },
      refresh: { kind: "never" },
    });
    const result = judgeRun(run);
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toEqual(
      expect.stringMatching(/^parse\.regex is not a valid regular expression:/),
    );
  });

  it("refuses a regex with a trailing backslash, which compiles only when alternated", () => {
    // The JS string is `(a)` followed by one backslash.
    const run = runOf({
      read: { kind: "file", path: "/etc/hosts", readMode: "whole" },
      parse: { kind: "regex", pattern: "(a)\\" },
      refresh: { kind: "never" },
    });
    const result = judgeRun(run);
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toEqual(
      expect.stringMatching(/^parse\.regex is not a valid regular expression:/),
    );
  });

  it("refuses a regex with no capture group", () => {
    const run = runOf({
      read: { kind: "file", path: "/etc/hosts", readMode: "whole" },
      parse: { kind: "regex", pattern: "v[0-9]+" },
      refresh: { kind: "never" },
    });
    expect(judgeRun(run)).toEqual({
      kind: "refused",
      reason:
        'parse.regex must contain a capture group — its group 1 is the value; got "v[0-9]+"',
    });
  });

  it("refuses a shell ttl under the floor, and accepts the same ttl on a file run", () => {
    const shell = runOf({
      read: { kind: "shell", command: "echo", cwd: "/" },
      parse: { kind: "text" },
      refresh: { kind: "ttl", durationMs: 50 },
    });
    expect(judgeRun(shell)).toEqual({
      kind: "refused",
      reason: `a shell source's cache.ttl must be at least ${MIN_SHELL_TTL_MS}ms, got 50ms`,
    });

    const file = runOf({
      read: { kind: "file", path: "/etc/hosts", readMode: "whole" },
      parse: { kind: "text" },
      refresh: { kind: "ttl", durationMs: 50 },
    });
    const result = judgeRun(file);
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") expect(result.run).toBe(file);
  });
});
