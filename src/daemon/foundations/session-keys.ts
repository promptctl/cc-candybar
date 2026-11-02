// The SessionState keys the daemon writes for itself, which every piece that
// reads or records a session's facts names alike.

// [LAW:one-source-of-truth] The config FILE is the one durable store
// (candybar-config-dqe). A click carries only a session id, so a render
// request records — under this daemon-internal key, the
// SESSION_CONFIG_OVERRIDE_KEY precedent — the INPUTS it named for config
// resolution, and a durable verb runs the same resolution over them, under
// the session's load-config pick, at click time (durableConfig). The
// file it lands in is the one the NEXT reload reads, not a snapshot of the
// one the last render read: RenderCache re-resolves the same chain whenever
// a candidate appears (a higher-precedence file supersedes a lower one), so
// a recorded resolved path would be a second clock — a write to a file the
// bar has already stopped reading. No re-derivation from the daemon's own
// cwd either, which describes whichever shell spawned it.
export const SESSION_RENDER_ORIGIN_KEY = "render-origin";

// [LAW:one-source-of-truth] Where the daemon records each session's STAMPED
// client hints (draw-bar.ts writes `JSON.stringify(parseClientHints(req))` here
// on every render request that changes them) — the SESSION_RENDER_ORIGIN_KEY move for
// client facts. A click carries no hints, so the doctor reasons over the facts
// of the session's last render, read back through the SAME checkpoint the live
// frame crossed (parseClientHints), never over the daemon's own env.
export const SESSION_CLIENT_HINTS_KEY = "client-hints";

// [LAW:effects-at-boundaries] Per-session config override stored in SessionState.
// Wire value: `<sessionId>/<percent-encoded-path>`. An empty path clears the
// override, restoring the request-derived config for that session only.
// Split at the FIRST slash — the session ID is slash-free (requireSessionId),
// and the path contains slashes that must not be split.
// [LAW:no-silent-failure] Path validation is at the verb boundary so a bad path
// fails the click (BAD_REQUEST), not the next render.
export const SESSION_CONFIG_OVERRIDE_KEY = "config-override";
