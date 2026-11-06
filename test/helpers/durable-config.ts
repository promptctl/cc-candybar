// [LAW:one-source-of-truth] The durable store under test IS the config file
// (candybar-config-dqe). A test that drives persist/reset/undo/redo clicks
// through the real verb handlers needs exactly what a real session has: a
// config file the session "rendered from", the render origin that names it
// in SessionState, and the daemon's settings history beside it. This fixture
// stands those three up under one temp root and tears them down together,
// so no suite re-spells the origin key or the history path.
//
// [LAW:single-enforcer] Everything that steers where a durable write lands is
// the fixture's renderer home, under its own root: the history path and the
// first-ever-write fallback both derive from it, and a test hands the home and
// its host to what it drives. (A developer's own CC_CANDYBAR_CONFIG cannot leak
// in: the daemon reads none — it is a client hint, composed into the render
// origin, brandon-config-5g8.)

import { requestedConfigTarget } from "../../src/config-hint";
import { hostOf } from "./host";
import type { Host } from "../../src/host";
import {
  HOME_ENV,
  NAME_ENV,
  homeOf,
  type RendererHome,
} from "../../src/daemon/home";
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
import {
  SettingsHistory,
  fileHistoryStorage,
  type HistoryStorage,
  type SessionHistory,
  type Step,
} from "../../src/daemon/settings-history";
import {
  configDir,
  settingsHistoryPath,
  storedRoot,
} from "../../src/daemon/paths";
import { SESSION_RENDER_ORIGIN_KEY } from "../../src/daemon/foundations/session-keys";
import { encodeRenderOrigin } from "../../src/daemon/foundations/render-origin";

export interface DurableConfig {
  /** The host whose environment names the fixture's home. */
  readonly host: Host;
  /** The renderer home the fixture's files are under. */
  readonly home: RendererHome;
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
  history(sessionId?: string): SessionHistory;
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
    sessionId: string,
    configFile?: string,
  ): void;
  dispose(): void;
}

export function durableConfig(prefix = "cc-candybar-durable-"): DurableConfig {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const host = hostOf({
    ...process.env,
    [HOME_ENV]: join(root, "home"),
    [NAME_ENV]: "durable",
  });
  const home = homeOf(host);
  // Anything the storage logs is a history the daemon would drop or fail to
  // keep, so it fails the test rather than reading as empty stacks.
  const historyStorage = (): HistoryStorage =>
    fileHistoryStorage(
      settingsHistoryPath(home),
      storedRoot(home),
      (level, message) => {
        throw new Error(`settings history ${level}: ${message}`);
      },
    );
  const configPath = join(configDir(home), "config.json5");
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
    home,
    projectDir: root,
    configPath,
    projectPath: join(root, ".cc-candybar.json5"),
    historyPath: settingsHistoryPath(home),
    write: (text) => writeFileSync(configPath, text),
    text: readText,
    parsed: () => JSON5.parse(readText() ?? "") as Record<string, unknown>,
    // The history as the next daemon loads it. The file itself is created by
    // the first step, so before one an absent file and an absent entry both
    // read as the empty stack.
    history: (sessionId = "s1") =>
      historyStorage().load()[sessionId] ?? { past: [], future: [] },
    fileStep: (before, after, file = configPath) => [
      { kind: "file", file, before, after },
    ],
    historyFor: (sessionState) =>
      new SettingsHistory(sessionState, () => {}, historyStorage()),
    seedOrigin: (sessionState, sessionId, configFile) =>
      sessionState.set(
        sessionId,
        SESSION_RENDER_ORIGIN_KEY,
        encodeRenderOrigin(
          {
            projectDir: root,
            cwd: root,
            target: requestedConfigTarget(configFile, undefined),
          },
          storedRoot(home),
        ),
      ),
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
