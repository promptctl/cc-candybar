// [LAW:one-source-of-truth] The durable store under test IS the config file.
// [LAW:single-enforcer] Env vars steering a durable write are isolated here.

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
  readonly projectDir: string;
  readonly configPath: string;
  /** Where a write lands while `configPath` does NOT exist: the XDG tail. */
  readonly xdgConfigPath: string;
  readonly historyPath: string;
  write(text: string): void;
  text(): string | null;
  parsed(): Record<string, unknown>;
  history(file?: string): FileHistory;
  seedOrigin(
    sessionState: SessionStateRW,
    sessionId: string,
    configFile?: string,
  ): void;
  dispose(): void;
}

type EnvVars = Readonly<Record<string, string | undefined>>;

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
    // Before the first edit, an absent file and an absent entry both read as the empty stack.
    history: (file = configPath) =>
      (
        JSON.parse(readOrNull(configEditHistoryPath()) ?? "{}") as Record<
          string,
          FileHistory
        >
      )[file] ?? { past: [], future: [] },
    seedOrigin: (sessionState, sessionId, configFile) =>
      sessionState.set(
        sessionId,
        SESSION_RENDER_ORIGIN_KEY,
        encodeRenderOrigin({
          projectDir: root,
          cwd: root,
          configFile: configFile ?? null,
        }),
      ),
    dispose: () => {
      assignEnv(saved);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
