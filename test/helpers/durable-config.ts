// [LAW:one-source-of-truth] The durable store under test IS the config file
// (candybar-config-dqe). A test that drives persist/reset/undo/redo clicks
// through the real verb handlers needs exactly what a real session has: a
// config file the session "rendered from", the context the host holds that
// names it, and the session's settings history. This fixture stands those
// three up under one temp root and tears them down together.
//
// [LAW:single-enforcer] Every env var that steers where a durable write lands
// is isolated in the fixture's `host`, which a test hands to what it drives:
// the XDG pair derive the first-ever-write fallback. (A
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
import type { SessionStateRW } from "../../src/renderer-interface/session-state";
import {
  sessionIdOf,
  type SessionId,
} from "../../src/daemon/foundations/session-id";
import { SettingsHistory } from "../../src/renderer/settings-history";
import {
  type SessionHistory,
  type Step,
} from "../../src/renderer/history-steps";
import { digestOf } from "../../src/utils/plain";
import { recordRenderOf, renderedContext } from "./click";

export interface DurableConfig {
  /** The machine the fixture's files are under: its XDG pair names them. */
  readonly host: Host;
  /** The session's projectDir AND cwd — the temp root. */
  readonly projectDir: string;
  /** The user's XDG `config.json5` — the file every durable write lands in. */
  readonly configPath: string;
  /** `<projectDir>/.cc-candybar.json5` — a project layer over `configPath`. */
  readonly projectPath: string;
  write(text: string): void;
  /** The file's current text, or null when it does not exist. */
  text(): string | null;
  /** The file parsed as JSON5 (throws when absent). */
  parsed(): Record<string, unknown>;
  /** Session `sessionId`'s history as the last `historyFor` holds it — empty until its first step. */
  history(sessionId?: SessionId): SessionHistory;
  /** A settings history over `sessionState`, holding what the last one built kept. */
  historyFor(sessionState: SessionStateRW): SettingsHistory;
  /** The one-change step a single write to the user layer records. */
  fileStep(before: string | null, after: string): Step;
  /**
   * The context the host holds so a click resolves this file — or, with
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
  let built: SettingsHistory | null = null;
  return {
    host,
    projectDir: root,
    configPath,
    projectPath: join(root, ".cc-candybar.json5"),
    write: (text) => writeFileSync(configPath, text),
    text: readText,
    parsed: () => JSON5.parse(readText() ?? "") as Record<string, unknown>,
    history: (sessionId = sessionIdOf("s1")) =>
      built?.history(sessionId) ?? { past: [], future: [] },
    fileStep: (before, after) => [
      { kind: "layer", role: "user", file: digestOf(configPath), before, after },
    ],
    // A history after the first starts with what the last one kept, as a
    // restarted renderer is handed it.
    historyFor: (sessionState) => {
      const next = new SettingsHistory(sessionState, () => {});
      if (built !== null) next.restore(built.versions());
      return (built = next);
    },
    seedOrigin: (sessionState, sessionId, configFile) =>
      recordRenderOf(sessionState, {
        ...renderedContext(sessionId, root),
        requested: {
          projectDir: root,
          cwd: root,
          target: requestedConfigTarget(configFile, undefined),
        },
      }),
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
