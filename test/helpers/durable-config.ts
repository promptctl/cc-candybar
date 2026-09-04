// [LAW:one-source-of-truth] The durable store under test IS the config file
// (candybar-config-dqe). A test that drives persist/reset/undo/redo clicks
// through the real verb handlers needs exactly what a real session has: a
// config file the session "rendered from", the render origin that names it
// in SessionState, and the daemon's edit history beside it. This fixture
// stands those three up under one temp root and tears them down together,
// so no suite re-spells the origin key or the history path.
//
// [LAW:single-enforcer] Every env var that steers where a durable write lands
// is isolated here, for the fixture's lifetime, and restored on dispose: the
// XDG pair derive the history path and the first-ever-write fallback, and
// CC_CANDYBAR_CONFIG outranks the whole chain — left alone, a developer's own
// setting would route every click in every suite to their real config file.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import type { SessionStateRW } from "../../src/daemon/session-state";
import type { FileHistory } from "../../src/daemon/config-file-store";
import { configEditHistoryPath } from "../../src/daemon/paths";
import {
  SESSION_RENDER_ORIGIN_KEY,
  encodeRenderOrigin,
} from "../../src/daemon/verbs";

export interface DurableConfig {
  /** The session's projectDir AND cwd — the temp root. */
  readonly projectDir: string;
  /** `<projectDir>/.cc-candybar.json5` — the file a write lands in once it exists. */
  readonly configPath: string;
  /** Where a write lands while `configPath` does NOT exist: the XDG tail. */
  readonly xdgConfigPath: string;
  readonly historyPath: string;
  write(text: string): void;
  /** The file's current text, or null when it does not exist. */
  text(): string | null;
  /** The file parsed as JSON5 (throws when absent). */
  parsed(): Record<string, unknown>;
  /** The history stack of `configPath` (or `file`) — empty until its first edit. */
  history(file?: string): FileHistory;
  /** What the render handler records so a click resolves this file. */
  seedOrigin(sessionState: SessionStateRW, sessionId: string): void;
  dispose(): void;
}

type EnvVars = Readonly<Record<string, string | undefined>>;

/** Set each var to its value; undefined unsets it. */
function assignEnv(vars: EnvVars): void {
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

export function durableConfig(prefix = "cc-candybar-durable-"): DurableConfig {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const isolated: EnvVars = {
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    CC_CANDYBAR_CONFIG: undefined,
  };
  const saved: EnvVars = Object.fromEntries(
    Object.keys(isolated).map((name) => [name, process.env[name]]),
  );
  assignEnv(isolated);
  const configPath = join(root, ".cc-candybar.json5");
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
    projectDir: root,
    configPath,
    xdgConfigPath: join(root, "xdg-config", "cc-candybar", "config.json5"),
    historyPath: configEditHistoryPath(),
    write: (text) => writeFileSync(configPath, text),
    text: readText,
    parsed: () => JSON5.parse(readText() ?? "") as Record<string, unknown>,
    // The history file itself is created by the first edit, so before one an
    // absent file and an absent entry both read as the empty stack.
    history: (file = configPath) =>
      (
        JSON.parse(readOrNull(configEditHistoryPath()) ?? "{}") as Record<
          string,
          FileHistory
        >
      )[file] ?? { past: [], future: [] },
    seedOrigin: (sessionState, sessionId) =>
      sessionState.set(
        sessionId,
        SESSION_RENDER_ORIGIN_KEY,
        encodeRenderOrigin({ projectDir: root, cwd: root, configFile: null }),
      ),
    dispose: () => {
      assignEnv(saved);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
