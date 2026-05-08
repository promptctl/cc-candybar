// [LAW:single-enforcer] One place resolves the "random" sentinel into a
// concrete value, keyed by sessionId so the random pick is *stable for the
// life of that session* (matching theme-cycle's "pick once, stay until
// changed" model). Each setting (theme / style / endpoints) flows through
// the same pattern: read sessionState → if cached return it → if config says
// "random" pick + cache → otherwise return config value as-is.
//
// The cache is sessionState itself: that means a) clicks like theme-cycle
// continue to work (they overwrite the same key), and b) the dataflow is
// uniform — no parallel "random cache" to keep in sync with sessionState.

import { pickRandomTheme, DISPLAY_STYLES } from "./cascade.js";
import { STYLE_ORDER } from "./default-mapping.js";

interface SessionStateRW {
  get(sessionId: string, key: string): string | null;
  set(sessionId: string, key: string, value: string): void;
}

const SENTINEL = "random";

// [LAW:dataflow-not-control-flow] Same shape every call — the only branch is
// "is this random?" and that's a value-driven question, not a control-flow
// special case. No early returns hide the cache write from later readers.
function resolve(
  sessionId: string,
  key: string,
  configValue: string | undefined,
  sessionState: SessionStateRW | undefined,
  pick: () => string,
  fallback: string,
): string {
  if (!sessionState) {
    return configValue === SENTINEL ? pick() : (configValue ?? fallback);
  }
  const cached = sessionState.get(sessionId, key);
  if (cached) return cached;
  if (configValue !== SENTINEL) return configValue ?? fallback;
  const chosen = pick();
  sessionState.set(sessionId, key, chosen);
  return chosen;
}

export function resolveSessionTheme(
  sessionId: string,
  configTheme: string | undefined,
  sessionState: SessionStateRW | undefined,
): string {
  return resolve(
    sessionId,
    "theme",
    configTheme,
    sessionState,
    pickRandomTheme,
    "dark",
  );
}

export function resolveSessionStyle(
  sessionId: string,
  configStyle: string | undefined,
  sessionState: SessionStateRW | undefined,
): string {
  return resolve(
    sessionId,
    "style",
    configStyle,
    sessionState,
    () => STYLE_ORDER[Math.floor(Math.random() * STYLE_ORDER.length)]!,
    "surface",
  );
}

export function resolveSessionDisplayStyle(
  sessionId: string,
  configDisplayStyle: string | undefined,
  sessionState: SessionStateRW | undefined,
): "minimal" | "powerline" | "capsule" {
  const value = resolve(
    sessionId,
    "displayStyle",
    configDisplayStyle,
    sessionState,
    () => DISPLAY_STYLES[Math.floor(Math.random() * DISPLAY_STYLES.length)]!,
    "minimal",
  );
  return value === "powerline" || value === "capsule" ? value : "minimal";
}
