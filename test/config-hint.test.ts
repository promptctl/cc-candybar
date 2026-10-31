// [LAW:behavior-not-structure] The client's CC_CANDYBAR_CONFIG probe: total
// over the environment, "unset or empty" is the affirmative "no override",
// and a set value leaves the client absolute — resolved against the client's
// own cwd, never left for the detached daemon to resolve against its own
// (brandon-config-nuq6). The Rust client's config_env_hint test holds the
// same table.
import os from "node:os";
import path from "node:path";
import { CONFIG_ENV, cliConfigTarget, detectConfigEnv } from "../src/config-hint";

const CWD = "/work/proj";

describe("detectConfigEnv (client-side CC_CANDYBAR_CONFIG probe)", () => {
  test("names the documented variable", () => {
    expect(CONFIG_ENV).toBe("CC_CANDYBAR_CONFIG");
  });

  test("unset or empty is no override", () => {
    expect(detectConfigEnv({}, CWD)).toBeUndefined();
    expect(detectConfigEnv({ CC_CANDYBAR_CONFIG: "" }, CWD)).toBeUndefined();
  });

  test("a set value is resolved against the client's cwd, `~` against home", () => {
    const hint = (v: string) => detectConfigEnv({ CC_CANDYBAR_CONFIG: v }, CWD);
    expect(hint("/etc/bar.json5")).toBe("/etc/bar.json5");
    expect(hint("examples/demo.json5")).toBe("/work/proj/examples/demo.json5");
    expect(hint("../x/./y.json5")).toBe("/work/x/y.json5");
    expect(hint("~/bar.json5")).toBe(path.join(os.homedir(), "bar.json5"));
    expect(hint("~")).toBe(os.homedir());
    expect(hint("~alice/c.json5")).toBe("/work/proj/~alice/c.json5");
  });
});

// [LAW:single-enforcer] brandon-unfiled-3248.e3r: the one composition `check`
// and `doctor` judge a config under. An empty argument — `"$CFG"` with CFG
// unset — is no argument, as it is to the bar's `--config`, so the variable
// is the target; a named file outranks the variable.
describe("cliConfigTarget (the file a CLI run checks)", () => {
  const ENV = { CC_CANDYBAR_CONFIG: "env.json5" };

  test("no argument, or an empty one, falls to $CC_CANDYBAR_CONFIG", () => {
    const environment = { source: "environment", path: "/work/proj/env.json5" };
    expect(cliConfigTarget(undefined, ENV, CWD)).toEqual(environment);
    expect(cliConfigTarget("", ENV, CWD)).toEqual(environment);
  });

  test("with neither, the run searches", () => {
    expect(cliConfigTarget("", {}, CWD)).toEqual({ source: "search" });
    expect(cliConfigTarget(undefined, {}, CWD)).toEqual({ source: "search" });
  });

  test("a named file outranks the variable and is resolved against cwd", () => {
    expect(cliConfigTarget("mine.json5", ENV, CWD)).toEqual({
      source: "argument",
      path: "/work/proj/mine.json5",
    });
    expect(cliConfigTarget("/etc/bar.json5", ENV, CWD)).toEqual({
      source: "argument",
      path: "/etc/bar.json5",
    });
  });

  test("the argument wins by source even where the variable names the same file", () => {
    expect(cliConfigTarget("env.json5", ENV, CWD).source).toBe("argument");
  });
});
