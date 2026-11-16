// [LAW:single-enforcer] Where a config write lands: the host applies a
// renderer's `change` to its layer's file as the file stands, keeping every
// byte the change does not touch, and refuses the change whole when a setting
// it read has moved since the renderer read it. No renderer writes the file.

import fs from "node:fs";
import {
  addressText,
  applyChanges,
  type Read,
} from "../config/config-changes.js";
import type {
  ConfigChange,
  EffectOutcome,
} from "../renderer-interface/interface.js";
import { resolvedTarget, writeAtomic } from "../utils/atomic-write.js";

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};

const said = (read: Read): string =>
  read.kind === "absent" ? "nothing" : read.text;

// [LAW:no-silent-failure] Every way the change did not land is its outcome,
// naming the file, and the setting when one moved.
export function performChange(change: ConfigChange): EffectOutcome {
  const file = change.target.path;
  try {
    const applied = applyChanges(readText(file), change.changes);
    if (applied.kind === "moved")
      return {
        kind: "failed",
        reason: `${addressText(applied.at)} in ${file} changed since it was read (it was ${said(applied.read)}, it is ${said(applied.found)}) — nothing was written`,
      };
    if (applied.text === null) fs.rmSync(resolvedTarget(file), { force: true });
    else writeAtomic(file, applied.text);
    return { kind: "ok" };
  } catch (e) {
    return {
      kind: "failed",
      reason: `config write failed (${file}): ${(e as Error).message}`,
    };
  }
}
