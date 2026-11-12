import {
  parseSessionId,
  sessionIdOf,
  type SessionId,
} from "../../src/daemon/session-id";

// The session a test draws for when its payload names none.
export const TEST_SESSION = sessionIdOf("test-session");

// The session a test payload's view draws for: its `session_id`, checked as
// the hook door checks it (a malformed one throws), or the test's own session
// when it carries none.
export function sessionOfPayload(payload: unknown): SessionId {
  const raw = (payload as { session_id?: unknown } | null)?.session_id;
  if (raw === undefined) return TEST_SESSION;
  const session = parseSessionId(raw);
  if (!session.ok)
    throw new Error(`test payload session_id ${session.problem}`);
  return session.id;
}
