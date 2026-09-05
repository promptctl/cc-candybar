// [LAW:behavior-not-structure] The client's CC_CANDYBAR_CONFIG probe: total
// over the environment, raw on the way out (the daemon's checkpoint expands
// `~`), and "unset or empty" is the affirmative "no override".
import { CONFIG_ENV, detectConfigEnv } from "../src/config-hint";

describe("detectConfigEnv (client-side CC_CANDYBAR_CONFIG probe)", () => {
  test("names the documented variable", () => {
    expect(CONFIG_ENV).toBe("CC_CANDYBAR_CONFIG");
  });

  test("unset or empty is no override", () => {
    expect(detectConfigEnv({})).toBeUndefined();
    expect(detectConfigEnv({ CC_CANDYBAR_CONFIG: "" })).toBeUndefined();
  });

  test("a set value is reported verbatim — `~` is the daemon's to expand", () => {
    expect(detectConfigEnv({ CC_CANDYBAR_CONFIG: "~/bar.json5" })).toBe(
      "~/bar.json5",
    );
  });
});
