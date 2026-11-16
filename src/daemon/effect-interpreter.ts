// [LAW:single-enforcer] Where a config write lands: the host applies a turn's
// `change`s to their files as the files stand, keeping every byte a change
// does not touch, and lands them together or not at all. Every read in every
// file is checked before any file is written, and a write that fails puts
// back the files already written. No renderer writes a config file.

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

const writeText = (file: string, text: string | null): void =>
  text === null
    ? fs.rmSync(resolvedTarget(file), { force: true })
    : writeAtomic(file, text);

const said = (read: Read | "object"): string =>
  read === "object"
    ? "an object"
    : read.kind === "absent"
      ? "nothing"
      : read.text;

// A file as it stood, and as the turn's changes leave it.
interface Landing {
  readonly file: string;
  readonly was: string | null;
  readonly will: string | null;
}

// [LAW:no-silent-failure] Every way the turn's changes did not land is their
// one outcome, naming the file, and the setting when one moved.
export function performChanges(
  changes: readonly ConfigChange[],
): EffectOutcome {
  const landings = new Map<string, Landing>();
  try {
    for (const { target, changes: list } of changes) {
      const file = target.path;
      const was = landings.get(file)?.was ?? readText(file);
      const applied = applyChanges(landings.get(file)?.will ?? was, list);
      if (applied.kind === "moved")
        return {
          kind: "refused",
          reason: `${addressText(applied.at)} in ${file} changed since it was read (it was ${said(applied.read)}, it is ${said(applied.found)}) — nothing was written`,
        };
      landings.set(file, { file, was, will: applied.text });
    }
  } catch (e) {
    return { kind: "failed", reason: `config read failed: ${message(e)}` };
  }
  const written: Landing[] = [];
  try {
    for (const landing of landings.values()) {
      writeText(landing.file, landing.will);
      written.push(landing);
    }
    return { kind: "ok" };
  } catch (e) {
    return { kind: "failed", reason: putBack(written, e) };
  }
}

// The files a failed write already wrote, put back as they stood.
function putBack(written: readonly Landing[], cause: unknown): string {
  const reason = `config write failed: ${message(cause)}`;
  try {
    for (const { file, was } of [...written].reverse()) writeText(file, was);
    return `${reason} — nothing was written`;
  } catch (e) {
    return `${reason}; and putting back what was written failed, so it is half-written: ${message(e)}`;
  }
}

const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
