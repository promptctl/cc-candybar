// The host's judge of a shell or file run: each rule accepts a run that keeps
// it and refuses one that breaks it, naming why.
import { ok } from "../../src/utils/outcome";

import { judgeRun, MIN_SHELL_TTL_MS } from "../../src/daemon/judge-run";
import { runOf, type SourceIdentity } from "../../src/facts/source-identity";

const shell: SourceIdentity = {
  read: { kind: "shell", command: "echo hi", cwd: "/work" },
  parse: { kind: "text" },
  refresh: { kind: "never" },
};
const file: SourceIdentity = {
  read: { kind: "file", path: "/work/status.json", readMode: "whole" },
  parse: { kind: "json" },
  refresh: { kind: "never" },
};

const verdict = (identity: SourceIdentity) => {
  const judged = judgeRun(runOf(identity));
  return judged.kind === "accepted" ? "accepted" : judged.reason;
};

describe("judgeRun", () => {
  it("accepts a run that keeps every rule, carrying its digest and the parser it reads with", () => {
    const run = runOf({
      ...file,
      parse: { kind: "regex", pattern: "v(\\d+)" },
      refresh: { kind: "watch_file", path: "/work/status.json" },
    });
    const judged = judgeRun(run);
    expect(judged).toMatchObject({ kind: "accepted", digest: run.digest, run });
    if (judged.kind !== "accepted") throw new Error("refused");
    expect(judged.run.parser("v42")).toEqual(ok("42"));
    expect(
      verdict({
        ...shell,
        refresh: { kind: "ttl", durationMs: MIN_SHELL_TTL_MS },
      }),
    ).toBe("accepted");
  });

  it.each(["status.json", "~/status.json", ""])(
    "refuses a file path that is not absolute: %j",
    (path) => {
      expect(
        verdict({
          ...file,
          read: { ...file.read, path } as SourceIdentity["read"],
        }),
      ).toBe(
        `file.path must be an absolute path (\`~\` and relative paths are not expanded), got ${JSON.stringify(path)}`,
      );
    },
  );

  it("refuses a watch_file path that is not absolute", () => {
    expect(
      verdict({
        ...shell,
        refresh: { kind: "watch_file", path: ".budget.json" },
      }),
    ).toBe(
      'cache.watch_file must be an absolute path (`~` and relative paths are not expanded), got ".budget.json"',
    );
  });

  it.each(["(", "(a)\\"])(
    "refuses a regex that does not compile: %j",
    (pattern) => {
      expect(verdict({ ...shell, parse: { kind: "regex", pattern } })).toMatch(
        /^parse\.regex is not a valid regular expression: /,
      );
    },
  );

  it("refuses a regex with no group 1", () => {
    expect(
      verdict({ ...shell, parse: { kind: "regex", pattern: "v[0-9]+" } }),
    ).toBe(
      'parse.regex must contain a capture group — its group 1 is the value; got "v[0-9]+"',
    );
  });

  it("refuses a shell ttl below the floor, and not a file's", () => {
    const fast = { kind: "ttl", durationMs: 50 } as const;
    expect(verdict({ ...shell, refresh: fast })).toBe(
      `a shell source's cache.ttl must be at least ${MIN_SHELL_TTL_MS}ms, got 50ms`,
    );
    expect(verdict({ ...file, refresh: fast })).toBe("accepted");
  });

  it("refuses with the run's digest, so its lane is keyed as the renderer named it", () => {
    const run = runOf({
      ...file,
      read: { ...file.read, path: "x" } as SourceIdentity["read"],
    });
    expect(judgeRun(run)).toMatchObject({
      kind: "refused",
      digest: run.digest,
    });
  });
});
