// [LAW:one-source-of-truth] The durable store under test IS the config file
// (candybar-config-dqe). A test that drives persist/reset/undo/redo clicks
// through the real verb handlers needs exactly what a real session has: a
// config file the session "rendered from", the render origin that names it
// in SessionState, and the daemon's settings history beside it. This fixture
// stands those three up under one temp root and tears them down together,
// so no suite re-spells the origin key or the history path.
//
// [LAW:single-enforcer] Every env var that steers where a durable write lands
// is isolated in the fixture's `host`, which a test hands to what it drives:
// the XDG pair derive the history path and the first-ever-write fallback. (A
// developer's own CC_CANDYBAR_CONFIG cannot leak in: the daemon reads none —
// it is a client hint, composed into the render origin, brandon-config-5g8.)

import { requestedConfigTarget } from "../../src/config-hint";
import { HOST, hostOf } from "./host";
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
import type { SessionStateRW } from "../../src/daemon/session-state";
import { sessionIdOf, type SessionId } from "../../src/daemon/session-id";
import {
  SettingsHistory,
  fileHistoryStorage,
  type SessionHistory,
  type Step,
} from "../../src/daemon/settings-history";
import { settingsHistoryPath } from "../../src/daemon/paths";
import { SESSION_RENDER_ORIGIN_KEY } from "../../src/daemon/foundations/session-keys";
import { encodeRenderOrigin } from "../../src/daemon/foundations/render-origin";

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
  /** Session `sessionId`'s history as the file holds it — empty until its first step. */
  history(sessionId?: SessionId): SessionHistory;
  /** A settings history over `sessionState`, stored in this fixture's state dir. */
  historyFor(sessionState: SessionStateRW): SettingsHistory;
  /** The one-change step a single write to `file` (default `configPath`) records. */
  fileStep(before: string | null, after: string, file?: string): Step;
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
  return {
    host,
    projectDir: root,
    configPath,
    projectPath: join(root, ".cc-candybar.json5"),
    historyPath: settingsHistoryPath(host),
    write: (text) => writeFileSync(configPath, text),
    text: readText,
    parsed: () => JSON5.parse(readText() ?? "") as Record<string, unknown>,
    // The history file itself is created by the first step, so before one an
    // absent file and an absent entry both read as the empty stack.
    history: (sessionId = sessionIdOf("s1")) =>
      (
        JSON.parse(readOrNull(settingsHistoryPath(host)) ?? "{}") as Record<
          string,
          SessionHistory
        >
      )[sessionId] ?? { past: [], future: [] },
    fileStep: (before, after, file = configPath) => [
      { kind: "file", file, before, after },
    ],
    historyFor: (sessionState) =>
      new SettingsHistory(
        sessionState,
        () => {},
        fileHistoryStorage(settingsHistoryPath(host), () => {}),
      ),
    seedOrigin: (sessionState, sessionId, configFile) =>
      sessionState.set(
        sessionId,
        SESSION_RENDER_ORIGIN_KEY,
        encodeRenderOrigin({
          projectDir: root,
          cwd: root,
          target: requestedConfigTarget(configFile, undefined),
        }),
      ),
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
