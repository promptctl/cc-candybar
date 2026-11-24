// [LAW:one-source-of-truth] The durable store under test IS the config file
// (candybar-config-dqe). A test that drives persist/reset/undo/redo clicks
// through the real verb handlers needs exactly what a real session has: a
// config file the session "rendered from", the render origin that names it
// in SessionState, and the settings history the host keeps. This fixture
// stands those three up under one temp root and tears them down together,
// so no suite re-spells the origin key or the history path.
//
// [LAW:single-enforcer] Every env var that steers where a durable write lands
// is isolated in the fixture's `host`, which a test hands to what it drives:
// the XDG pair derive the history path and the first-ever-write fallback. (A
// developer's own CC_CANDYBAR_CONFIG cannot leak in: the daemon reads none —
// it is a client hint, composed into the render origin, brandon-config-5g8.)

import { requestedConfigTarget } from "../../src/config-hint";
import { HOST, hostOf } from "../../scripts/lib/host";
import type { Host } from "../../src/host";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import JSON5 from "json5";
import type { SessionStateRW } from "../../src/renderer-interface/session-state";
import {
  sessionIdOf,
  type SessionId,
} from "../../src/daemon/foundations/session-id";
import { SettingsHistory } from "../../src/renderer/settings-history";
import {
  type SessionHistory,
  type Step,
} from "../../src/renderer-interface/history-storage";
import { settingsHistoryPath } from "../../src/daemon/paths";
import { digestOf } from "../../src/utils/plain";
import { fileHistoryStorage } from "../../src/daemon/history-file";
import { HeldStores } from "../../src/daemon/held-stores";
import { ephemeralSessionFile } from "../../src/daemon/session-state-file";
import { recordRender } from "./click";
import { heldClock } from "./held-clock";

export interface DurableConfig {
  /** The machine the fixture's files are under: its XDG pair names them. */
  readonly host: Host;
  /** The session's projectDir AND cwd — the temp root. */
  readonly projectDir: string;
  /** The user's XDG `config.json5` — the file every durable write lands in. */
  readonly configPath: string;
  /** `<projectDir>/.cc-candybar.json5` — a project layer over `configPath`. */
  readonly projectPath: string;
  readonly historyPath: string;
  write(text: string): void;
  /** The file's current text, or null when it does not exist. */
  text(): string | null;
  /** The file parsed as JSON5 (throws when absent). */
  parsed(): Record<string, unknown>;
  /** Session `sessionId`'s history as the last `historyFor` holds it — empty until its first step. */
  history(sessionId?: SessionId): SessionHistory;
  /**
   * A settings history over `sessionState`, which `history` then reads, built
   * from the history file as a restarted renderer is: the one made before it
   * first hands its writes to the file, as its turns would have.
   */
  historyFor(sessionState: SessionStateRW): SettingsHistory;
  /** The one-change step a single write to `configPath`, the user layer, records. */
  fileStep(before: string | null, after: string): Step;
  /**
   * What the render handler records so a click resolves this file — or, with
   * `configFile`, the explicit path the session's render was composed from.
   */
  seedOrigin(
    sessionState: SessionStateRW,
    sessionId: SessionId,
    configFile?: string,
  ): void;
  dispose(): void;
}

export function durableConfig(prefix = "cc-candybar-durable-"): DurableConfig {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const host = hostOf({
    ...process.env,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
  });
  const configPath = join(root, "xdg-config", "cc-candybar", "config.json5");
  mkdirSync(dirname(configPath), { recursive: true });
  const readOrNull = (file: string): string | null => {
    try {
      return readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  };
  const readText = (): string | null => readOrNull(configPath);
  let made: SettingsHistory | null = null;
  // The host's stores over this fixture's history file, as a daemon loads them.
  const profile = (): HeldStores => {
    const stores = new HeldStores(
      {
        session: ephemeralSessionFile(),
        history: fileHistoryStorage(settingsHistoryPath(host), () => {}),
      },
      // An order alone waits for a period no case here reaches.
      heldClock(new Date()),
    );
    stores.load();
    return stores;
  };
  return {
    host,
    projectDir: root,
    configPath,
    projectPath: join(root, ".cc-candybar.json5"),
    historyPath: settingsHistoryPath(host),
    write: (text) => writeFileSync(configPath, text),
    text: readText,
    parsed: () => JSON5.parse(readText() ?? "") as Record<string, unknown>,
    history: (sessionId = sessionIdOf("s1")) =>
      made?.history(sessionId) ?? { past: [], future: [] },
    fileStep: (before, after) => [
      {
        kind: "layer",
        role: "user",
        digest: digestOf(configPath),
        before,
        after,
      },
    ],
    historyFor: (sessionState) => {
      if (made !== null) profile().take(made.drain());
      return (made = new SettingsHistory(
        sessionState,
        () => {},
        profile().current().history,
      ));
    },
    seedOrigin: (sessionState, sessionId, configFile) =>
      recordRender(sessionState, sessionId, root, {
        target: requestedConfigTarget(configFile, undefined),
      }),
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
