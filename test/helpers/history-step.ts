// A settings history driven as one click drives it, with no host: the journal
// a click opens, its file writes landing in place, and its commit. A test of
// what a click's changes do on their way to the host drives a click instead
// (test/helpers/click.ts).

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { EditStore } from "../../src/renderer/config-file-store";
import type {
  ConfigFiles,
  Journal,
  SettingsHistory,
} from "../../src/renderer/settings-history";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import type { Step } from "../../src/renderer-interface/history-storage";

// A file's text on disk, or null when there is none.
export function readConfigText(file: string): string | null {
  try {
    return readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// A history's files with no click around it: read from and written to the
// disk at once, with no home to prove a step's text against.
export const WRITES_IN_PLACE: ConfigFiles = {
  read: readConfigText,
  land: (file, _before, after) =>
    after === null ? rmSync(file, { force: true }) : writeFileSync(file, after),
  prove: () => {},
};

// A config writer's store with no click around it: it reads the disk, and
// what it records lands at once.
export const EDITS_IN_PLACE: EditStore = {
  read: readConfigText,
  record: (file, _before, after) => writeFileSync(file, after),
};

// One click's journal over `history`: what `act` does, then the commit.
export function clickOf<T>(
  history: SettingsHistory,
  act: (journal: Journal) => T,
): T {
  const journal = history.begin(WRITES_IN_PLACE);
  // A click commits whatever its handler threw, as the click path does: a
  // refused step's forgetting is part of what it did.
  try {
    return act(journal);
  } finally {
    journal.commit();
  }
}

export const undoOf = (history: SettingsHistory, sid: SessionId): Step =>
  clickOf(history, (journal) => journal.undo(sid));

export const redoOf = (history: SettingsHistory, sid: SessionId): Step =>
  clickOf(history, (journal) => journal.redo(sid));

export const rewindOf = (history: SettingsHistory, sid: SessionId): Step =>
  clickOf(history, (journal) => journal.rewind(sid));
