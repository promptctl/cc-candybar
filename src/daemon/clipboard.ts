// The host's clipboard: a copy effect's text written through pbcopy, under
// the bound a click's program has.

import { failureText, type Launcher } from "../proc/launch.js";
import type { EffectOutcome } from "../renderer/interface.js";
import { CLICK_PROGRAM_TIMEOUT_MS } from "./verbs/index.js";

// [LAW:no-silent-failure] Every launch that did not end ok is the copy's
// failure in the launcher's own words, a rate limit's refusal included: the
// clipboard was not written.
export function launchedClipboard(
  launcher: Pick<Launcher, "launch">,
): (text: string) => Promise<EffectOutcome> {
  return async (text) => {
    const result = await launcher.launch({
      bin: "/usr/bin/pbcopy",
      stdinInput: text,
      category: "click.pbcopy",
      timeoutMs: CLICK_PROGRAM_TIMEOUT_MS,
    });
    return result.ok
      ? { kind: "ok" }
      : { kind: "failed", reason: `pbcopy ${failureText(result)}` };
  };
}
