// The host's interpreter for a config write (docs/design/host-and-renderer.md
// §7, "Effects"): it finds the file a `change` names by its session and role,
// splices the changes into the text it holds there, and refuses the whole
// change when a setting the renderer read has moved since. Every outcome is
// an `effect-done` the renderer hears.
//
// [LAW:effects-at-boundaries] The renderer decides what a write means and
// returns it as data; this is where the file is touched.

import fs from "node:fs";
import { applyChanges, movedText } from "../config/config-changes";
import type {
  ConfigChange,
  EffectOutcome,
} from "../renderer-interface/interface";
import { resolvedTarget, writeAtomic } from "../utils/atomic-write";
import type { DaemonLogger } from "../utils/logger";
import type { SessionId } from "./foundations/session-id";

export interface ConfigInterpreter {
  readonly change: (effect: ConfigChange) => EffectOutcome;
}

export function configInterpreter(deps: {
  // [LAW:single-enforcer] The file of a session's user layer, by the origin of
  // the newest request the host holds of it; null when it holds none, so the
  // renderer named a session the host was not handing it.
  readonly userLayer: (session: SessionId) => string | null;
  readonly log: DaemonLogger;
}): ConfigInterpreter {
  return {
    change: (effect) => {
      const file = deps.userLayer(effect.session);
      if (file === null) {
        return {
          kind: "failed",
          reason: `the host holds no request of session ${effect.session}, so it names no ${effect.target.role} layer for it`,
        };
      }
      try {
        const applied = applyChanges(readText(file), effect.changes);
        if (applied.kind === "moved") {
          // [LAW:no-silent-failure] Refused whole, naming the setting: a hand
          // edit or another session's write is never overwritten.
          const reason = `${file}: ${movedText(applied)} — refusing to overwrite it`;
          deps.log(
            "warn",
            `config: change refused (session=${effect.session}) ${reason}`,
          );
          return { kind: "refused", reason };
        }
        writeText(file, applied.text);
        deps.log(
          "info",
          `config: wrote ${file} changes=${effect.changes.length} (session=${effect.session})`,
        );
        return { kind: "ok" };
      } catch (e) {
        const reason = `config write failed (${file}): ${(e as Error).message}`;
        deps.log("error", reason);
        return { kind: "failed", reason };
      }
    },
  };
}

// The file's text, or null when it does not exist.
function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// [LAW:dataflow-not-control-flow] Null text is the absent file: undo of a
// first-ever write removes what that write created, wherever its link chain
// put it.
function writeText(file: string, text: string | null): void {
  if (text === null) fs.rmSync(resolvedTarget(file), { force: true });
  else writeAtomic(file, text);
}
