import {
  parseSessionId,
  sessionIdOf,
  type SessionId,
} from "../../src/daemon/session-id";

// The session a test draws for when its payload names none.
export const TEST_SESSION = sessionIdOf("test-session");

// The session a test payload's view draws for: its `session_id`, as the hook
// door checks it, or the test's own session when it carries none.
export function sessionOfPayload(payload: unknown): SessionId {
  const session = parseSessionId(
    (payload as { session_id?: unknown } | null)?.session_id,
  );
  return session.ok ? session.id : TEST_SESSION;
}
