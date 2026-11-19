// A settings history driven as one click drives it, with no host: the journal
// a click opens, its file writes landing in place, and its commit. A test of
// what a click's changes do on their way to the host drives a click instead
// (test/helpers/click.ts).

import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  writeLayerOf,
  type EditStore,
  type WriteLayer,
} from "../../src/renderer/config-file-store";
import type { Host } from "../../src/host";
import type { RenderOrigin } from "../../src/config-hint";
import { LAYER_ROLES, type LayerRole } from "../../src/config/layer-role";
import { locations } from "../../src/daemon/paths";
import { discoveryNow } from "./click";
import { contentOfText } from "../../src/config/config-snapshot";
import { readConfigText } from "../../src/utils/atomic-write";
import type {
  ConfigFiles,
  Journal,
  SettingsHistory,
} from "../../src/renderer/settings-history";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import type { Step } from "../../src/renderer-interface/history-storage";
import type { DslConfig } from "../../src/config/dsl-types";

// The config a write loaded to, for a history no click reads it from: only a
// click's turn releases what its write ended (src/renderer/verbs/index.ts).
export const UNREAD_CONFIG = {} as DslConfig;

// A history's files with no click around it: the chain's layers at the paths
// `layers` names, read from and written to the disk at once, with no home to
// prove a step's text against.
export function inPlace(
  layers: Partial<Record<LayerRole, string>>,
): ConfigFiles {
  return {
    read: (file) => contentOfText(readConfigText(file)),
    land: (file, _before, after) =>
      after === null
        ? rmSync(file, { force: true })
        : writeFileSync(file, after),
    prove: () => UNREAD_CONFIG,
    roleOf: (file) => {
      const role = LAYER_ROLES.find((r) => layers[r] === file);
      if (role === undefined)
        throw new Error(`${file} is no layer of this history's chain`);
      return role;
    },
    pathOf: (role) => layers[role] ?? null,
  };
}

// A click of a session whose chain has no layer: its steps are session picks.
export const NO_LAYERS: ConfigFiles = inPlace({});

// A config writer's store with no click around it: it reads the disk, and
// what it records lands at once.
export const EDITS_IN_PLACE: EditStore = {
  read: (file) => contentOfText(readConfigText(file)),
  record: (file, _before, after) => writeFileSync(file, after),
};

// A chain's one layer, the user's `file`, with no plugin over it: what a
// writer does to one file, with nothing beneath or above it.
export function soleLayer(file: string, home: string): WriteLayer {
  const layer = {
    role: "user",
    path: file,
    content: { kind: "absent" },
    listed: {},
  } as const;
  return {
    ...layer,
    snapshot: {
      chain: [layer],
      repo: null,
      plugins: [],
      strays: [],
      checkout: { root: path.dirname(file), git: false },
      notices: [],
      watch: null,
    },
    home,
  };
}

// The layer `role` names in the chain discovery finds at `origin` now, as a
// click of a session there writes it.
export function layerNow(
  host: Host,
  origin: RenderOrigin,
  role: LayerRole,
): WriteLayer {
  return writeLayerOf(
    discoveryNow(host).snapshotOf(origin),
    role,
    origin.target.path ?? null,
    locations(host).home,
  );
}

// One click's journal over `history`: what `act` does, then the commit.
export function clickOf<T>(
  history: SettingsHistory,
  files: ConfigFiles,
  act: (journal: Journal) => T,
): T {
  const journal = history.begin(files);
  // A click commits whatever its handler threw, as the click path does: a
  // refused step's forgetting is part of what it did.
  try {
    return act(journal);
  } finally {
    journal.commit();
  }
}

export const undoOf = (
  history: SettingsHistory,
  sid: SessionId,
  files: ConfigFiles,
): Step => clickOf(history, files, (journal) => journal.undo(sid));

export const redoOf = (
  history: SettingsHistory,
  sid: SessionId,
  files: ConfigFiles,
): Step => clickOf(history, files, (journal) => journal.redo(sid));
