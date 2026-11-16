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
import {
  readConfigText,
  resolvedTarget,
  writeAtomic,
} from "../utils/atomic-write.js";

const writeText = (file: string, text: string | null): void =>
  text === null
    ? fs.rmSync(resolvedTarget(file), { force: true })
    : writeAtomic(file, text);

const said = (read: Read | "object"): string =>
  read === "object"
    ? "an object"
    : read.kind === "absent"
      ? "nothing"
      : read.kind === "file"
        ? "the file as it was read"
        : read.text;

// A file as it stood, and as the turn's changes leave it.
interface Rewrite {
  readonly file: string;
  readonly was: string | null;
  readonly will: string | null;
}

// [LAW:no-silent-failure] Every way the turn's changes did not land is their
// one outcome, naming the file, and the setting when one moved.
export function performChanges(
  changes: readonly ConfigChange[],
): EffectOutcome {
  const rewrites = new Map<string, Rewrite>();
  try {
    for (const { target, changes: list } of changes) {
      // Keyed by the file a write lands in, so two paths to one file are one
      // rewrite of it.
      const file = resolvedTarget(target.path);
      // A file an earlier change of the turn named, as that change left it,
      // an absent one included.
      const prior = rewrites.get(file);
      const was = prior === undefined ? readConfigText(file) : prior.was;
      const applied = applyChanges(
        prior === undefined ? was : prior.will,
        list,
      );
      if (applied.kind === "moved")
        return {
          kind: "refused",
          reason: `${addressText(applied.at)} in ${file} changed since it was read (it was ${said(applied.read)}, it is ${said(applied.found)}) — nothing was written`,
        };
      rewrites.set(file, { file, was, will: applied.text });
    }
  } catch (e) {
    return { kind: "failed", reason: `config read failed: ${message(e)}` };
  }
  const written: Rewrite[] = [];
  try {
    for (const rewrite of rewrites.values()) {
      writeText(rewrite.file, rewrite.will);
      written.push(rewrite);
    }
    return { kind: "ok" };
  } catch (e) {
    return { kind: "failed", reason: putBack(written, e) };
  }
}

// The files a failed write already wrote, put back as they stood.
function putBack(written: readonly Rewrite[], cause: unknown): string {
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
