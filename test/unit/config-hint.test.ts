// [LAW:behavior-not-structure] The client's CC_CANDYBAR_CONFIG probe: total
// over the environment, "unset or empty" is the affirmative "no override",
// and a set value leaves the client absolute — resolved against the client's
// own cwd, never left for the detached daemon to resolve against its own
// (brandon-config-nuq6). The Rust client's config_env_hint test holds the
// same table.
import path from "node:path";
import { hostOf } from "../helpers/host";
import {
  CONFIG_ENV,
  detectConfigEnv,
} from "../../src/config-hint";

const CWD = "/work/proj";
// A home no machine has, so `~` expands to the host a test states.
const HOME = "/home/test";
const on = (env: NodeJS.ProcessEnv) => hostOf(env, { home: HOME });

describe("detectConfigEnv (client-side CC_CANDYBAR_CONFIG probe)", () => {
  test("names the documented variable", () => {
    expect(CONFIG_ENV).toBe("CC_CANDYBAR_CONFIG");
  });

  test("unset or empty is no override", () => {
    expect(detectConfigEnv(on({}), CWD)).toBeUndefined();
    expect(
      detectConfigEnv(on({ CC_CANDYBAR_CONFIG: "" }), CWD),
    ).toBeUndefined();
  });

  test("a set value is resolved against the client's cwd, `~` against home", () => {
    const hint = (v: string) =>
      detectConfigEnv(on({ CC_CANDYBAR_CONFIG: v }), CWD);
    expect(hint("/etc/bar.json5")).toBe("/etc/bar.json5");
    expect(hint("examples/demo.json5")).toBe("/work/proj/examples/demo.json5");
    expect(hint("../x/./y.json5")).toBe("/work/x/y.json5");
    expect(hint("~/bar.json5")).toBe(path.join(HOME, "bar.json5"));
    expect(hint("~")).toBe(HOME);
    expect(hint("~alice/c.json5")).toBe("/work/proj/~alice/c.json5");
  });
});

// [LAW:single-enforcer] brandon-unfiled-3248.e3r: the one composition `check`
// and `doctor` judge a config under. An empty argument — `"$CFG"` with CFG
// unset — is no argument, as it is to the bar's `--config`, so the variable
// is the target; a named file outranks the variable.
